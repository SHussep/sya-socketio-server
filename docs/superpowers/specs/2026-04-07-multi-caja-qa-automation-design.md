# Multi-Caja QA Automation — Design Spec

> **Para quien lea esto:** Este documento describe el sistema de pruebas automatizadas que
> verifica que el flujo completo de multi-caja funcione correctamente: desde crear ventas,
> gastos, retiros, devoluciones y liquidaciones, hasta verificar que los cortes de caja
> cuadren en todos los dispositivos. Si el código cambia y algo se rompe, estas pruebas lo detectan.

## Contexto del Problema

SYA Tortillerías opera con múltiples terminales (cajas) por sucursal. Cada terminal abre
su propio turno, registra ventas, gastos, depósitos, retiros, y al final del día cierra
un corte de caja. Los repartidores salen con producto, hacen ventas en ruta, registran
gastos desde la app móvil (Flutter), devuelven producto sobrante, y se liquidan.

**El riesgo:** Cada actualización de código puede romper silenciosamente alguno de estos flujos.
Una venta que se filtra al turno equivocado, un gasto rechazado que aparece en el corte,
un descuento que no se aplica — cualquiera de estos errores causa que el corte de caja
no cuadre, generando problemas reales para el negocio.

**La solución:** Un test suite automatizado que simula escenarios reales de multi-caja
contra la base de datos de Render (PostgreSQL) y verifica que todos los números cuadren.
Se ejecuta manualmente con `npm run test:qa` antes de cada deploy.

## Decisiones de Diseño

| Decisión | Elección | Razón |
|----------|----------|-------|
| Framework | Jest (existente) | Ya está configurado, los helpers de test existen |
| DB de pruebas | Render PostgreSQL (producción/staging) | Evita mantener una DB separada con seeds |
| Datos seed | Tenant, branch, empleados, productos existentes | Evita la complejidad de crear todo desde cero |
| Simulación multi-caja | Socket.IO + REST API híbrido | Socket.IO para eventos real-time, REST para sync payloads |
| Verificación de cortes | Expected values calculados + consistencia cross-device | Doble verificación: los números son correctos Y son iguales en todos lados |
| Ejecución | `npm run test:qa` manual pre-deploy | Sin CI/CD por ahora, el dev ejecuta antes de deployar |

## Arquitectura

```
tests/
├── helpers/
│   ├── test-setup.js            ← Existente. Se extiende con nuevos helpers.
│   ├── scenario-builder.js      ← NUEVO. API fluida para construir escenarios.
│   └── corte-calculator.js      ← NUEVO. Calculadora independiente de corte esperado.
├── multi-branch.test.js         ← Existente. Tests de aislamiento por sucursal.
├── sync-server-first.test.js    ← Existente. Tests de sync por entidad.
└── multi-caja-qa.test.js        ← NUEVO. Suite principal de QA multi-caja.
```

### Componente 1: Scenario Builder (`scenario-builder.js`)

**Qué hace:** Envuelve las llamadas REST API y conexiones Socket.IO en una API legible.
En lugar de hacer HTTP requests manuales, los tests leen como una historia:

```js
const cajaA = await scenario.createTerminal({
  terminalId: 'TEST-CAJA-A',
  employeeGlobalId: 'emp-cajero-1'
});

await cajaA.openShift(500);
await cajaA.createSale({
  items: [{ productGlobalId: 'prod-tortilla-maiz', quantity: 5, unitPrice: 22 }],
  paymentType: 'cash',
  cashAmount: 110
});
await cajaA.createExpense({ categoryId: 2, amount: 150, description: 'Tanque gas' });
const corte = await cajaA.closeShift({ countedCash: 870 });
```

**Responsabilidades:**
- Maneja autenticación JWT por terminal
- Conecta Socket.IO para cada terminal (verifica eventos real-time)
- Mantiene un log de transacciones en memoria (para calcular expected values)
- Expone operaciones del repartidor: `assignToRepartidor()`, `registerReturn()`,
  `changeAssignmentClient()`, `liquidate()`, `reviewExpense()`
- Ejecuta cleanup de todos los registros creados

**Interfaz pública:**

```
ScenarioBuilder
  ├── constructor({ baseUrl, tenantId, branchId })
  ├── createTerminal({ terminalId, employeeGlobalId, clientType? }) → Terminal
  ├── queryCorte(corteId) → corte data from server
  ├── queryBranchSummary() → branch-level aggregated totals
  └── cleanup() → deletes all test records in reverse FK order

Terminal
  ├── openShift(initialAmount) → shift data
  ├── createSale({ items, paymentType, cashAmount?, cardAmount?, creditAmount?, clientGlobalId?, discounts? }) → sale data
  ├── createExpense({ categoryId, amount, description, status? }) → expense data
  ├── createDeposit(amount, description) → deposit data
  ├── createWithdrawal(amount, description) → withdrawal data
  ├── assignToRepartidor({ repartidorEmployeeGlobalId, items }) → assignment data
  ├── registerReturn(assignmentId, { items: [{ productGlobalId, quantityReturned }] }) → return data
  ├── changeAssignmentClient(assignmentId, { newClientGlobalId }) → updated assignment
  ├── liquidate(assignmentId, { cashAmount, cardAmount, creditAmount, clientGlobalId }) → liquidation data
  ├── reviewExpense(expenseId, { action: 'approve'|'reject'|'edit', amount?, reason? }) → updated expense
  ├── createCreditPayment({ clientGlobalId, amount, paymentType }) → payment data
  ├── closeShift({ countedCash }) → corte data
  ├── getTransactionLog() → array of all operations performed
  └── getSocket() → raw Socket.IO client for event assertions
```

### Componente 2: Corte Calculator (`corte-calculator.js`)

**Qué hace:** Función pura que recibe una lista de transacciones y calcula qué DEBERÍA
dar el corte de caja. Es completamente independiente del servidor — no hace queries,
no llama APIs. Si el servidor calcula mal, esta función detecta la diferencia.

**Fórmulas:**

```
totalCashSales     = SUM(sale.cashAmount)  where paymentType in ('cash', 'mixed')
totalCardSales     = SUM(sale.cardAmount)  where paymentType in ('card', 'mixed')
totalCreditSales   = SUM(sale.creditAmount) where paymentType in ('credit', 'mixed')

totalExpenses      = SUM(expense.amount) where status = 'confirmed'
totalDeposits      = SUM(deposit.amount)
totalWithdrawals   = SUM(withdrawal.amount)

totalCashPayments  = SUM(creditPayment.amount) where paymentType = 'cash'
totalCardPayments  = SUM(creditPayment.amount) where paymentType = 'card'

liqCash            = SUM(liquidacion.cashAmount)
liqCard            = SUM(liquidacion.cardAmount)
liqCredit          = SUM(liquidacion.creditAmount)

expectedCashInDrawer = initialAmount
                     + totalCashSales
                     + totalCashPayments
                     + totalDeposits
                     + liqCash
                     - totalExpenses
                     - totalWithdrawals

difference = countedCash - expectedCashInDrawer
```

**Importante:** Los gastos con `status = 'rejected'` o `status = 'draft'` NO se incluyen
en el cálculo. Solo los `confirmed` afectan el corte.

### Componente 3: Test Suite (`multi-caja-qa.test.js`)

**6 bloques de escenarios, 13+ tests:**

#### Bloque 1: Terminal Única — Operaciones Básicas
Verifica que el corte cuadre con operaciones simples.

- Abrir turno con monto inicial ($500)
- 3 ventas en efectivo (diferentes productos y cantidades)
- 1 venta con tarjeta
- 1 gasto (Gas LP, $150)
- 1 depósito ($200)
- 1 retiro ($300)
- Cerrar turno → comparar corte real vs esperado

**Assertions:**
- `expectedCash = 500 + cashSales + 200 - 150 - 300`
- `totalCardSales` incluye solo la venta con tarjeta
- `difference = countedCash - expectedCash`

#### Bloque 2: Terminal Única — Descuentos y Crédito
Verifica que descuentos y crédito se apliquen correctamente.

- Venta con precio especial por producto (cliente tiene precio especial en Tortilla Maíz)
- Venta con descuento global de cliente (porcentaje, ej. 10%)
- Venta con descuento global fijo ($5 por kg)
- Venta a crédito completa (sin pago)
- Pago parcial de crédito (efectivo)
- Pago total de crédito (tarjeta)
- Cerrar turno

**Assertions:**
- Descuentos reducen `total` pero no `subtotal`
- Ventas a crédito aparecen en `totalCreditSales` pero NO en `expectedCashInDrawer`
- Pagos de crédito aparecen en `totalCashPayments` / `totalCardPayments`

#### Bloque 3: Multi-Caja — Aislamiento
Verifica que dos terminales no se contaminen.

- Terminal A abre turno ($500)
- Terminal B abre turno ($300)
- Terminal A: 2 ventas en efectivo
- Terminal B: 1 venta en efectivo, 1 gasto
- Cerrar Terminal A → corte solo incluye transacciones de A
- Cerrar Terminal B → corte solo incluye transacciones de B

**Assertions:**
- Ninguna transacción de B aparece en el corte de A (y viceversa)
- Totales de sucursal = suma de ambos cortes
- Heartbeat de un terminal no afecta al otro

#### Bloque 4: Repartidor — Ciclo Completo
Verifica el flujo completo de reparto.

- Cajero abre turno
- Asignar productos a repartidor (3 productos, diferentes unidades: kg, pz)
- Repartidor registra gasto desde móvil (Gasolina, $80) → status = `draft`
- Desktop aprueba gasto → status = `confirmed`
- Repartidor devuelve producto parcial (2 de 5 kg Tortilla Maíz)
- Cambiar cliente en una asignación (cliente incorrecto → correcto)
- Liquidar: pago mixto (efectivo $200 + tarjeta $100 + crédito $50)
- Cerrar turno

**Assertions:**
- `totalKilosVendidos = asignados - devueltos`
- `montoTotalVendido = vendidos × precio`
- `netoAEntregar = montoVendido - gastos`
- Cambio de cliente se refleja en la asignación final
- Efectivo/tarjeta/crédito de liquidación fluyen correctamente al corte

#### Bloque 5: Repartidor — Flujo de Gastos
Verifica el workflow de aprobación/rechazo/edición de gastos.

- Repartidor envía gasto ($50, Combustible) → `draft`
- Desktop rechaza con razón → `rejected`
- Repartidor reenvía corregido → `draft`
- Desktop edita monto ($45) y aprueba → `confirmed`
- Segundo gasto ($30, Comida) → Desktop aprueba directamente
- Cerrar turno

**Assertions:**
- Solo gastos `confirmed` ($45 + $30 = $75) aparecen en corte
- Gasto rechazado NO aparece
- Monto editado usa el valor corregido ($45, no $50)

#### Bloque 6: Consistencia Cross-Device
Verifica que todos los dispositivos ven los mismos números.

- Ejecuta el mismo escenario del Bloque 4
- Consulta el corte desde: Terminal A (REST), el servidor (shift endpoint), resumen de sucursal
- Compara los tres resultados

**Assertions (los tres deben ser idénticos):**
- `totalCashSales`, `totalCardSales`, `totalCreditSales`
- `totalExpenses`, `totalDeposits`, `totalWithdrawals`
- `expectedCashInDrawer`, `difference`
- Subtotales de liquidación

## Cleanup y Seguridad de Datos

### Estrategia: Transaction Log + Borrado en Orden Inverso

El `ScenarioBuilder` trackea cada registro que crea (array en memoria) y los borra
en orden inverso de dependencias FK al terminar.

**Orden de borrado:**
1. `credit_payments`
2. `sale_items` → `sales`
3. `repartidor_returns` → `repartidor_assignments`
4. `repartidor_liquidations`
5. `cash_cuts`
6. `expenses`
7. `deposits`
8. `withdrawals`
9. `shifts`

**Nunca se borran:** employees, products, clients, branches (son datos seed permanentes).

### Identificación de Datos de Test

Cada registro creado por el test suite incluye un tag en `device_event_raw`:

```json
{
  "test_run_id": "qa-run-2026-04-07-a1b2c3",
  "test_suite": "multi-caja-qa",
  "created_by": "automated-test"
}
```

### Guards de Seguridad

- **Terminal IDs con prefijo `TEST-`**: `TEST-CAJA-A`, `TEST-CAJA-B`. Producción nunca usa este prefijo.
- **Cleanup en `beforeAll` Y `afterAll`**: `beforeAll` limpia datos huérfanos de corridas previas fallidas.
- **Timeout safety**: Si cleanup falla, el test loguea el `test_run_id` para limpiar manualmente:
  ```bash
  node scripts/cleanup/clean-test-run.js --run-id=qa-run-2026-04-07-a1b2c3
  ```

## Configuración y Ejecución

### Variables de Entorno

Las mismas que ya usa el proyecto (no se necesitan nuevas para infra):

```
TEST_SERVER_URL    — URL del servidor Render
JWT_SECRET         — Para generar JWTs de test
DATABASE_URL       — PostgreSQL de Render
```

Nuevas variables para identificar datos seed existentes:

```
QA_TENANT_ID=1
QA_BRANCH_ID=1
QA_CAJERO_1_GLOBAL_ID=<global_id del empleado cajero 1>
QA_CAJERO_2_GLOBAL_ID=<global_id del empleado cajero 2>
QA_REPARTIDOR_GLOBAL_ID=<global_id del empleado repartidor>
QA_CLIENT_CREDIT_GLOBAL_ID=<global_id de cliente con crédito habilitado>
QA_CLIENT_DISCOUNT_GLOBAL_ID=<global_id de cliente con precios especiales>
```

### Scripts npm

```json
{
  "test": "jest --runInBand --forceExit",
  "test:qa": "jest tests/multi-caja-qa.test.js --runInBand --forceExit --timeout=120000"
}
```

### Cómo Ejecutar

```bash
# Desde C:\SYA\sya-socketio-server

# Suite completa
npm run test:qa

# Escenario específico
npm run test:qa -- --testNamePattern="Repartidor Full Lifecycle"

# Con output detallado
npm run test:qa -- --verbose
```

### Output Esperado (éxito)

```
PASS  tests/multi-caja-qa.test.js (45s)
  Single Terminal - Basic Operations
    ✓ corte matches expected cash/card/credit totals (3200ms)
    ✓ difference = counted - expected (850ms)
  Single Terminal - Discounts & Credit
    ✓ special price discount applied correctly (2100ms)
    ✓ credit sale excluded from cash drawer (1800ms)
    ✓ credit payment adds to cash drawer (1500ms)
  Multi-Caja Isolation
    ✓ Terminal A corte excludes Terminal B transactions (4200ms)
    ✓ Branch totals = sum of both cortes (1200ms)
  Repartidor Full Lifecycle
    ✓ liquidation totals: vendidos = asignados - devueltos (5500ms)
    ✓ client change reflected in final assignment (2100ms)
    ✓ liquidation cash/card/credit flow into corte (1800ms)
  Repartidor Expense Workflows
    ✓ rejected expense excluded from corte (3200ms)
    ✓ edited expense uses corrected amount (2400ms)
  Cross-Device Consistency
    ✓ Terminal A corte === server query === branch summary (2800ms)

Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
Cleanup:     12 shifts, 47 sales, 8 expenses deleted
```

### Output Esperado (fallo)

```
FAIL  Multi-Caja Isolation > Terminal A corte excludes Terminal B transactions
  Expected: totalCashSales = 330
  Received: totalCashSales = 440

  Transaction log for Terminal A:
    SALE #1: cash $110 (Tortilla Maíz 5kg × $22)
    SALE #2: cash $220 (Tortilla Maíz 10kg × $22)

  Unexpected transactions found in corte:
    SALE from Terminal B: cash $110 (leaked into Terminal A's shift)
```

El transaction log hace inmediatamente obvio qué falló y por qué.

## Relación con Tests Existentes

| Test Suite | Qué prueba | Se mantiene? |
|------------|-----------|-------------|
| `multi-branch.test.js` | Aislamiento Socket.IO por sucursal, heartbeats, session revocation | Sí, sin cambios |
| `sync-server-first.test.js` | Cada entidad sincroniza correctamente (campos, FKs, idempotencia) | Sí, sin cambios |
| `multi-caja-qa.test.js` (NUEVO) | Flujo completo multi-caja: transacciones → corte → verificación cruzada | Nuevo |
| `LiquidacionCalculationTests.cs` (Desktop) | Fórmulas de cálculo de liquidación en C# | Sí, sin cambios |

Los tests nuevos complementan los existentes. No reemplazan nada.

## Glosario para Nuevos Colaboradores

| Término | Significado |
|---------|-------------|
| **Turno / Shift** | Período de trabajo de un cajero. Se abre con monto inicial, se cierra con corte de caja. |
| **Corte de Caja / Cash Cut** | Cierre del turno: compara el efectivo esperado en caja vs el contado físicamente. |
| **Multi-Caja** | Modo donde varias terminales (cajas) operan en la misma sucursal, cada una con su propio turno. |
| **Terminal** | Dispositivo físico (PC, tablet). Identificado por `terminal_id` (UUID del hardware). |
| **Repartidor** | Empleado que sale a entregar producto. Lleva un inventario asignado y regresa con producto sobrante + dinero. |
| **Liquidación** | Proceso donde el cajero cuadra lo que el repartidor vendió vs lo que regresó vs lo que cobra. |
| **Asignación** | Productos que se le dan al repartidor para vender en ruta. |
| **Devolución** | Producto que el repartidor no vendió y regresa. |
| **Gasto** | Dinero que sale de caja (gas, combustible, etc.). Los repartidores pueden registrar gastos desde la app móvil. |
| **Depósito** | Dinero que entra a caja (cambio del banco, etc.). |
| **Retiro** | Dinero que sale de caja (pago a proveedor, etc.). |
| **Offline-First** | Patrón donde los datos se crean localmente (SQLite) y se sincronizan al servidor (PostgreSQL) después. |
| **Server-First** | En multi-caja, los datos van primero al servidor para evitar conflictos entre terminales. |
| **`global_id`** | UUID único generado en el dispositivo. Garantiza idempotencia: si se sincroniza dos veces, no se duplica. |
| **`device_event_raw`** | Campo JSON libre en cada registro. Los tests lo usan para tagear datos de prueba con `test_run_id`. |
| **Precio Especial** | Precio diferenciado por cliente y producto. El cliente "María" paga $20/kg en lugar de $22/kg. |
| **Descuento Global** | Descuento que aplica a todas las compras de un cliente (porcentaje o monto fijo). |
