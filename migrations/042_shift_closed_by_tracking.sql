-- Track who closed a shift and from which source (desktop/flutter)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closed_by_employee_id INTEGER REFERENCES employees(id);
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closed_source VARCHAR(20); -- 'desktop', 'flutter', 'sync'
