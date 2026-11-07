-- Apply once to a new Supabase project with the SQL editor or Supabase CLI.
begin;
create table public.rhb_teams (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 100),
 owner_id uuid not null default auth.uid() references auth.users(id), created_at timestamptz not null default now()
);
create table public.rhb_members (
 team_id uuid not null references public.rhb_teams(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, primary key(team_id,user_id)
);
create function public.rhb_member(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.rhb_teams where id=t and owner_id=auth.uid()) or
 exists(select 1 from public.rhb_members where team_id=t and user_id=auth.uid());
$$;
create function public.rhb_owner(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.rhb_teams where id=t and owner_id=auth.uid());
$$;
revoke all on function public.rhb_member(uuid),public.rhb_owner(uuid) from public;
grant execute on function public.rhb_member(uuid),public.rhb_owner(uuid) to authenticated;
alter table public.rhb_teams enable row level security;
alter table public.rhb_members enable row level security;
revoke all on public.rhb_teams,public.rhb_members from anon,authenticated;
grant select,insert,delete on public.rhb_teams to authenticated;
grant update(name) on public.rhb_teams to authenticated;
grant select,insert,delete on public.rhb_members to authenticated;
create policy teams_read on public.rhb_teams for select to authenticated using(owner_id=auth.uid() or public.rhb_member(id));
create policy teams_create on public.rhb_teams for insert to authenticated with check(owner_id=auth.uid());
create policy teams_update on public.rhb_teams for update to authenticated using(public.rhb_owner(id)) with check(owner_id=auth.uid());
create policy teams_delete on public.rhb_teams for delete to authenticated using(public.rhb_owner(id));
create policy members_read on public.rhb_members for select to authenticated using(public.rhb_member(team_id));
create policy members_add on public.rhb_members for insert to authenticated with check(public.rhb_owner(team_id));
create policy members_remove on public.rhb_members for delete to authenticated using(public.rhb_owner(team_id));

create table public.rhb_datasets (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.rhb_teams(id) on delete cascade,
 name text not null, source text not null, synthetic boolean not null default true,
 created_at timestamptz not null default now(), unique(team_id,name),unique(team_id,id)
);
create table public.rhb_records (
 id uuid primary key default gen_random_uuid(), team_id uuid not null, dataset_id uuid not null, record_key text not null,
 payload jsonb not null check(jsonb_typeof(payload)='object'), source_row integer not null check(source_row>=2),
 unique(dataset_id,record_key),foreign key(team_id,dataset_id) references public.rhb_datasets(team_id,id) on delete cascade
);
create table public.rhb_documents (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.rhb_teams(id) on delete cascade,
 filename text not null, storage_path text not null, sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 media_type text not null, parsed_text text, parser_job_id text,
 status text not null default 'uploaded' check(status in ('uploaded','parsing','parsed','failed')),
 created_at timestamptz not null default now(),unique(team_id,id),unique(team_id,sha256),
 check(split_part(storage_path,'/',1)=team_id::text)
);
create table public.rhb_evidence (
 id uuid primary key default gen_random_uuid(), team_id uuid not null, document_id uuid not null,
 start_offset integer not null check(start_offset>=0),end_offset integer not null,
 quote text not null,unique(team_id,id),unique(document_id,start_offset,end_offset),
 check(end_offset>start_offset),foreign key(team_id,document_id) references public.rhb_documents(team_id,id) on delete cascade
);
create table public.rhb_findings (
 id uuid primary key default gen_random_uuid(),team_id uuid not null references public.rhb_teams(id) on delete cascade,
 title text not null,detail text not null,rule text,severity text not null check(severity in ('low','medium','high')),
 method text not null check(method in ('deterministic','human','ai')),review_status text not null default 'open' check(review_status in ('open','confirmed','dismissed')),
 created_at timestamptz not null default now(),unique(team_id,id)
);
create table public.rhb_finding_evidence (
 team_id uuid not null,finding_id uuid not null,evidence_id uuid not null,primary key(finding_id,evidence_id),
 foreign key(team_id,finding_id) references public.rhb_findings(team_id,id) on delete cascade,
 foreign key(team_id,evidence_id) references public.rhb_evidence(team_id,id) on delete cascade
);
-- Every child row stays within a team, including composite foreign keys.
do $$ declare t text;begin
 foreach t in array array['rhb_datasets','rhb_records','rhb_documents','rhb_evidence','rhb_findings','rhb_finding_evidence'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to authenticated',t);
 execute format('create policy team_access on public.%I for all to authenticated using(public.rhb_member(team_id)) with check(public.rhb_member(team_id))',t);
 execute format('create index on public.%I(team_id)',t);
 end loop;
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('rhb-documents','rhb-documents',false,5242880,array['application/pdf','text/plain','text/csv']) on conflict(id) do nothing;
create function public.rhb_storage_member(object_name text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.rhb_teams t where t.id::text=split_part(object_name,'/',1) and public.rhb_member(t.id));
$$;
revoke all on function public.rhb_storage_member(text) from public;
grant execute on function public.rhb_storage_member(text) to authenticated;
create policy rhb_storage_select on storage.objects for select to authenticated using(bucket_id='rhb-documents' and public.rhb_storage_member(name));
create policy rhb_storage_insert on storage.objects for insert to authenticated with check(bucket_id='rhb-documents' and public.rhb_storage_member(name));
create policy rhb_storage_delete on storage.objects for delete to authenticated using(bucket_id='rhb-documents' and public.rhb_storage_member(name));
-- Transactional replacement: text and its excerpts never partially update.
create function public.rhb_save_document_text(p_document_id uuid,p_text text,p_chunks jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t uuid; n integer;
begin
 if length(p_text)>2000000 or jsonb_typeof(p_chunks)<>'array' then raise exception 'Invalid text or chunks';end if;
 select team_id into t from public.rhb_documents where id=p_document_id for update;
 if t is null then raise exception 'Document not accessible';end if;
 update public.rhb_documents set parsed_text=p_text,status='parsed' where id=p_document_id;
 delete from public.rhb_evidence where document_id=p_document_id;
 insert into public.rhb_evidence(team_id,document_id,start_offset,end_offset,quote)
 select t,p_document_id,c.start_offset,c.end_offset,c.quote
 from jsonb_to_recordset(p_chunks) as c(start_offset integer,end_offset integer,quote text);
 get diagnostics n=row_count;
 return jsonb_build_object('document_id',p_document_id,'chunks',n);
end $$;
revoke all on function public.rhb_save_document_text(uuid,text,jsonb) from public;
grant execute on function public.rhb_save_document_text(uuid,text,jsonb) to authenticated;
commit;
