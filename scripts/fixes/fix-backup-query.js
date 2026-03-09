const fs = require('fs');

const filePath = 'routes/backup.js';
let content = fs.readFileSync(filePath, 'utf8');

// Replace the specific query issue
const old1 = 'WHERE tenant_id = $1 AND branch_id = $2\n             ORDER BY created_at DESC\n             LIMIT $3 OFFSET $4';
const new1 = 'WHERE tenant_id = $1\n             ORDER BY created_at DESC\n             LIMIT $2 OFFSET $3';

if (content.includes(old1)) {
  content = content.replace(old1, new1);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✓ Fixed WHERE clause and LIMIT/OFFSET parameters');
} else {
  console.log('Pattern not found');
}
