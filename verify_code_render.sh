#!/bin/bash
echo "=== VERIFICACIÓN DE CÓDIGO EN RENDER ==="
echo ""

echo "1. Tamaño del archivo:"
ls -lh server.js | awk '{print $5, $9}'
echo ""

echo "2. Líneas del endpoint google-signup (208-260):"
sed -n '208p' server.js | cat -n
sed -n '228,257p' server.js | tail -5
echo ""

echo "3. Líneas del catch block (377-419):"
sed -n '377,385p' server.js
echo ""

echo "4. Grep de emailExists:"
grep -n "emailExists: true" server.js
echo ""

echo "5. Último commit:"
git log --oneline -1
echo ""

echo "6. Proceso Node.js activo:"
ps aux | grep node | grep -v grep
echo ""

echo "=== FIN ==="
