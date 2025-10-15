import sqlite3
import json

DB_PATH = r'C:\Users\saul_\AppData\Local\Packages\6a727d9d-d40f-407d-a7b7-655ca0f8161b_pkzpc8njrvjtr\LocalState\SYATortillerias.db3'

def analyze_database():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    print('📊 Analizando base de datos SQLite del Desktop...\n')

    # Obtener todas las tablas
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [row[0] for row in cursor.fetchall()]

    analysis = {}

    for table_name in tables:
        # Obtener estructura
        cursor.execute(f'PRAGMA table_info({table_name})')
        columns = cursor.execute(f'PRAGMA table_info({table_name})').fetchall()

        # Obtener conteo
        cursor.execute(f'SELECT COUNT(*) FROM {table_name}')
        count = cursor.fetchone()[0]

        analysis[table_name] = {
            'columns': [
                {
                    'cid': col[0],
                    'name': col[1],
                    'type': col[2],
                    'notnull': bool(col[3]),
                    'default_value': col[4],
                    'pk': bool(col[5])
                }
                for col in columns
            ],
            'recordCount': count
        }

    conn.close()

    # Imprimir análisis
    print('═══════════════════════════════════════════════════════')
    print('TABLAS CRÍTICAS EN DESKTOP (SQLite)')
    print('═══════════════════════════════════════════════════════\n')

    critical_tables = [
        'Shifts',
        'CashCuts',
        'Expenses',
        'ExpenseCategories',
        'Purchases',
        'PurchaseItems',
        'DeliveryAssignments',
        'Sales',
        'SaleItems',
        'Products',
        'ProductCategories',
        'Clientes',
        'Employees',
        'GuardianEvents',
        'CashDrawerMovements',
        'DepositsWithdrawals'
    ]

    for table_name in critical_tables:
        if table_name in analysis:
            table_info = analysis[table_name]
            print(f'\n📋 Tabla: {table_name}')
            print(f'   Registros: {table_info["recordCount"]}')
            print(f'   Columnas:')
            for col in table_info['columns']:
                pk = ' [PK]' if col['pk'] else ''
                notnull = ' NOT NULL' if col['notnull'] else ''
                print(f'      - {col["name"]:<30} {col["type"]:<15}{notnull}{pk}')
        else:
            print(f'\n❌ Tabla: {table_name} - NO EXISTE en Desktop')

    # Guardar JSON
    with open('C:/SYA/sya-socketio-server/desktop_db_analysis.json', 'w') as f:
        json.dump(analysis, f, indent=2)

    print('\n✅ Análisis guardado en desktop_db_analysis.json\n')

    return analysis

if __name__ == '__main__':
    analyze_database()
