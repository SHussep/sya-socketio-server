-- sync_census_reports
CREATE TABLE IF NOT EXISTS sync_census_reports (
    id BIGSERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    app_version TEXT,
    taken_at TIMESTAMPTZ NOT NULL,
    summary JSONB NOT NULL,
    by_entity_type JSONB NOT NULL,
    suspicious_records JSONB,
    handler_stats JSONB,
    received_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_census_tenant_device_time
    ON sync_census_reports(tenant_id, device_id, taken_at DESC);

-- sync_quarantine_reports
CREATE TABLE IF NOT EXISTS sync_quarantine_reports (
    id BIGSERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    app_version TEXT,
    quarantined_at TIMESTAMPTZ NOT NULL,
    entity_type TEXT NOT NULL,
    entity_global_id TEXT NOT NULL,
    entity_local_id INTEGER,
    entity_payload JSONB NOT NULL,
    entity_description TEXT,
    failure JSONB NOT NULL,
    dependencies JSONB,
    verify_result JSONB,
    admin_decision TEXT CHECK (admin_decision IN ('release','discard','force_synced') OR admin_decision IS NULL),
    admin_decided_at TIMESTAMPTZ,
    admin_decided_by INTEGER REFERENCES users(id),
    admin_notes TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quarantine_unique
    ON sync_quarantine_reports(tenant_id, device_id, entity_type, entity_global_id)
    WHERE admin_decision IS NULL;

-- sync_backup_requests
CREATE TABLE IF NOT EXISTS sync_backup_requests (
    id UUID PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    requested_by INTEGER NOT NULL REFERENCES users(id),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    upload_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','expired','failed')),
    uploaded_at TIMESTAMPTZ,
    storage_key TEXT,
    size_bytes BIGINT,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_requests_tenant
    ON sync_backup_requests(tenant_id, requested_at DESC);

-- sync_admin_command_log
CREATE TABLE IF NOT EXISTS sync_admin_command_log (
    command_id UUID PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL,
    admin_user_id INTEGER NOT NULL REFERENCES users(id),
    command_type TEXT NOT NULL,
    payload JSONB,
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    executed_at TIMESTAMPTZ,
    result TEXT,
    result_detail JSONB,
    status TEXT DEFAULT 'issued' CHECK (status IN ('issued','queued','executed','failed','expired'))
);
CREATE INDEX IF NOT EXISTS idx_admin_commands_tenant_time
    ON sync_admin_command_log(tenant_id, issued_at DESC);

-- super_admin_jwt_revocations
CREATE TABLE IF NOT EXISTS super_admin_jwt_revocations (
    jti UUID PRIMARY KEY,
    revoked_at TIMESTAMPTZ DEFAULT NOW(),
    reason TEXT
);

-- Columna para PIN del super-admin (bcrypt hash) usada por Task 4
ALTER TABLE users ADD COLUMN IF NOT EXISTS super_admin_pin TEXT;

-- Log de pushes FCM (Task 30) — throttle por admin+device
CREATE TABLE IF NOT EXISTS fcm_push_log (
    id BIGSERIAL PRIMARY KEY,
    admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    push_type TEXT NOT NULL DEFAULT 'quarantine_new',
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fcm_push_log_throttle
    ON fcm_push_log(admin_user_id, device_id, sent_at DESC);
