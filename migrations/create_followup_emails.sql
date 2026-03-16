-- Tabla para tracking de emails de seguimiento enviados
CREATE TABLE IF NOT EXISTS followup_emails (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    sent_to VARCHAR(255) NOT NULL,
    subject TEXT NOT NULL,
    scenario VARCHAR(50),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_followup_emails_tenant ON followup_emails(tenant_id);
CREATE INDEX idx_followup_emails_sent_at ON followup_emails(sent_at DESC);
