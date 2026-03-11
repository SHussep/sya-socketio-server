-- Migración: Agregar preferencias de email digest para reportes Guardian
-- Solo se envía al owner del tenant (único con email validado)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email_digest_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_digest_frequency VARCHAR(20) DEFAULT 'biweekly',
  ADD COLUMN IF NOT EXISTS email_digest_last_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_digest_next_send_at TIMESTAMPTZ;

-- Frecuencias válidas: 'weekly', 'biweekly', 'monthly', 'off'
-- Default: biweekly (cada 2 semanas)

-- Inicializar next_send_at para tenants existentes (próximo lunes a las 8am UTC)
UPDATE tenants
SET email_digest_next_send_at = (
    date_trunc('week', NOW()) + INTERVAL '1 week' + INTERVAL '14 hours'
)
WHERE email_digest_next_send_at IS NULL
  AND email_digest_enabled = true;
