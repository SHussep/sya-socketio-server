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
  tipoPagoId: 1,  // 1=Efectivo, 2=Tarjeta, 3=Crédito
  total: 110
});
await cajaA.createExpense({ categoryId: 2, amount: 150, description: 'Tanque gas' });
const corte = await cajaA.closeShift({ countedCash: 870 });
```

**Responsabilidades:**
- Maneja autenticación JWT por terminal
- Conecta Socket.IO para cada terminal (verifica eventos real-time)
- Mantiene un log de transacciones en memoria (para calcular expected values)
- Expone operaciones del repartidor: `assignToRepartidor()`, `registerReturn()`,
  `changeAssignmentClient()`, `liquidate()`, `approveExpense()`, `rejectExpense()`, `editExpense()`
- Asegura que cada venta incluya `fecha_venta_utc` dentro del rango del turno
- Ejecuta cleanup de todos los registros creados

**Interfaz pública:**

```
ScenarioBuilder
  ├── constructor({ baseUrl, tenantId, branchId })
  ├── createTerminal({ terminalId, employeeGlobalId, clientType? }) → Terminal
  ├── queryCorte(corteId) → GET /api/cash-cuts?shiftId=X
  ├── queryBranchSummary() → GET /api/cash-cuts?branch_id=X (all cortes for branch)
  └── cleanup() → deletes all test records in reverse FK order

Terminal
  ├── openShift(initialAmount) → shift data (stores shiftId, startTime internally)
  ├── createSale({ items, tipoPagoId, total, clientGlobalId?, discounts? }) → sale data
  │     tipoPagoId: 1=Efectivo, 2=Tarjeta, 3=Crédito
  │     Auto-sets: id_turno, fecha_venta_utc (within shift window), estado_venta_id=3
  ├── cancelSale(saleGlobalId) → sets estado_venta_id=4
  ├── createExpense({ categoryId, amount, description }) → expense data
  │     Auto-sets: id_turno, expense_date (within shift window), is_active=true
  ├── createDeposit(amount, description) → deposit data
  │     Auto-sets: shift_id, deposit_date (within shift window)
  ├── createWithdrawal(amount, description) → withdrawal data
  │     Auto-sets: shift_id, withdrawal_date (within shift window)
  ├── assignToRepartidor({ repartidorEmployeeGlobalId, items }) → assignment data
  ├── registerReturn(assignmentId, { items: [{ productGlobalId, quantityReturned }] }) → return data
  ├── changeAssignmentClient(assignmentId, { newClientGlobalId }) → updated assignment
  ├── liquidate(assignmentId, { cashAmount, cardAmount, creditAmount, clientGlobalId }) → liquidation data
  │     Creates ventas with estado_venta_id=5 and fecha_liquidacion_utc within shift window
  ├── approveExpense(expenseGlobalId) → PATCH /api/expenses/:global_id/approve
  ├── rejectExpense(expenseGlobalId, reason) → PUT /api/expenses/:global_id/deactivate
  │     Sets is_active=false (excluded from corte)
  ├── editExpense(expenseGlobalId, { amount?, description? }) → PATCH /api/expenses/:global_id
  ├── createCreditPayment({ clientGlobalId, amount, paymentMethod }) → payment data
  │     paymentMethod: 'cash' or 'card'. Auto-sets: shift_id, payment_date within window
  ├── closeShift({ countedCash, liquidacionTotals? }) → POST /api/cash-cuts → corte data
  │     liquidacionTotals auto-calculated from transaction log if not provided:
  │     { totalLiquidacionesEfectivo, totalLiquidacionesTarjeta, totalLiquidacionesCredito,
  │       totalRepartidorExpenses }
  ├── getTransactionLog() → array of all operations performed
  └── getSocket() → raw Socket.IO client for event assertions
```

**Nota sobre timestamps:** El Scenario Builder debe asegurar que TODAS las fechas de
transacciones (`fecha_venta_utc`, `expense_date`, `deposit_date`, `withdrawal_date`,
`payment_date`, `fecha_liquidacion_utc`) caigan dentro del rango `[shift.start_time, shift.end_time]`
del turno correspondiente. El servidor filtra por este rango al calcular el corte.
Si una fecha queda fuera del rango, esa transacción NO aparecerá en el corte.

### Componente 2: Corte Calculator (`corte-calculator.js`)

**Qué hace:** Función pura que recibe una lista de transacciones y calcula qué DEBERÍA
dar el corte de caja. Es completamente independiente del servidor — no hace queries,
no llama APIs. Si el servidor calcula mal, esta función detecta la diferencia.

**IMPORTANTE:** Las fórmulas a continuación replican exactamente la lógica SQL del servidor
en `routes/cash-cuts.js` líneas 162-262. Si el servidor cambia, estas fórmulas deben
actualizarse para coincidir.

**Fórmulas (replicando la lógica exacta del servidor):**

```
-- El servidor agrupa ventas por tipo_pago_id, usando SUM(total)
-- Solo cuenta ventas con estado_venta_id = 3 (Completada) o 5 (Liquidada)
-- Ventas completadas (estado 3): filtradas por id_turno = shiftId AND fecha_venta_utc dentro del turno
-- Ventas liquidadas (estado 5): filtradas por fecha_liquidacion_utc dentro del turno (sin filtro de id_turno)

totalCashSales   = SUM(venta.total) WHERE tipo_pago_id = 1
                   AND (
                     (estado_venta_id = 3 AND id_turno = shiftId AND fecha_venta_utc BETWEEN startTime AND endTime)
                     OR
                     (estado_venta_id = 5 AND COALESCE(fecha_liquidacion_utc, fecha_venta_utc) BETWEEN startTime AND endTime)
                   )

totalCardSales   = SUM(venta.total) WHERE tipo_pago_id = 2 AND [mismos filtros]
totalCreditSales = SUM(venta.total) WHERE tipo_pago_id = 3 AND [mismos filtros]

-- NOTA: tipo_pago_id = 4 (Mixto) NO está contemplado en la lógica del servidor.
-- Las ventas con pago mixto NO se incluyen en ningún total. Esto es un gap conocido
-- que se documenta con un test dedicado (ver Bloque 2).

-- Gastos: filtrados por id_turno, rango de fecha, Y is_active = true
-- IMPORTANTE: El filtro es is_active (soft-delete), NO status.
-- Un gasto con status='draft' pero is_active=true SÍ se incluye en el corte.
-- Un gasto rechazado tiene is_active=false y NO se incluye.
totalExpenses    = SUM(expense.amount) WHERE id_turno = shiftId
                   AND expense_date BETWEEN startTime AND endTime
                   AND is_active = true

-- Depósitos y retiros: filtrados por shift_id y rango de fecha
totalDeposits    = SUM(deposit.amount) WHERE shift_id = shiftId
                   AND deposit_date BETWEEN startTime AND endTime
totalWithdrawals = SUM(withdrawal.amount) WHERE shift_id = shiftId
                   AND withdrawal_date BETWEEN startTime AND endTime

-- Pagos de crédito: filtrados por shift_id, rango de fecha, y payment_method
totalCashPayments = SUM(credit_payment.amount) WHERE shift_id = shiftId
                    AND payment_date BETWEEN startTime AND endTime
                    AND payment_method = 'cash'
totalCardPayments = SUM(credit_payment.amount) WHERE shift_id = shiftId
                    AND payment_date BETWEEN startTime AND endTime
                    AND payment_method = 'card'

-- Liquidaciones: SON VALORES PROPORCIONADOS POR EL CLIENTE, NO CALCULADOS POR EL SERVIDOR
-- El Desktop calcula los totales de liquidación y los envía en el request de closeShift.
-- El servidor los almacena tal cual. El Scenario Builder debe calcularlos del transaction log.
liqCash   = SUM(liquidacion.cashAmount)   -- enviado como totalLiquidacionesEfectivo
liqCard   = SUM(liquidacion.cardAmount)   -- enviado como totalLiquidacionesTarjeta
liqCredit = SUM(liquidacion.creditAmount) -- enviado como totalLiquidacionesCredito
repartidorExpenses = SUM(expense.amount) WHERE from repartidor AND is_active = true

-- Fórmula final del servidor (routes/cash-cuts.js línea 262):
expectedCashInDrawer = initialAmount
                     + totalCashSales
                     + totalCashPayments
                     + liqCash          -- proporcionado por el cliente
                     + totalDeposits
                     - totalExpenses
                     - totalWithdrawals

difference = countedCash - expectedCashInDrawer
```

### Componente 3: Test Suite (`multi-caja-qa.test.js`)

**7 bloques de escenarios, 16+ tests:**

#### Bloque 1: Terminal Única — Operaciones Básicas
Verifica que el corte cuadre con operaciones simples.

- Abrir turno con monto inicial ($500)
- 3 ventas en efectivo (`tipo_pago_id=1`, diferentes productos y cantidades)
- 1 venta con tarjeta (`tipo_pago_id=2`)
- 1 venta que se crea y luego se cancela (`estado_venta_id` → 4) — NO debe contar en el corte
- 1 gasto (Gas LP, $150)
- 1 depósito ($200)
- 1 retiro ($300)
- Cerrar turno → comparar corte real vs esperado

**Assertions:**
- `expectedCash = 500 + cashSales + 200 - 150 - 300`
- `totalCardSales` incluye solo la venta con tarjeta
- Venta cancelada NO aparece en ningún total
- `difference = countedCash - expectedCash`

#### Bloque 2: Terminal Única — Descuentos y Crédito
Verifica que descuentos y crédito se apliquen correctamente.

- Venta con precio especial por producto (cliente tiene precio especial en Tortilla Maíz)
- Venta con descuento global de cliente (porcentaje, ej. 10%)
- Venta con descuento global fijo ($5 por kg)
- Venta a crédito completa (`tipo_pago_id=3`, sin pago)
- Pago parcial de crédito (`payment_method='cash'`)
- Pago total de crédito (`payment_method='card'`)
- **Venta con pago mixto** (`tipo_pago_id=4`, $100 cash + $50 card) — documenta el comportamiento actual
- Cerrar turno

**Assertions:**
- Descuentos reducen `total` pero no `subtotal`
- Ventas a crédito aparecen en `totalCreditSales` pero NO en `expectedCashInDrawer`
- Pagos de crédito aparecen en `totalCashPayments` / `totalCardPayments`
- **Venta mixta (tipo_pago_id=4):** Assert que NO aparece en ningún total del corte.
  Este test documenta un gap conocido del servidor. Si el servidor se corrige en el futuro
  para manejar pagos mixtos, el test fallará — señalando que el corte-calculator también
  necesita actualizarse.

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
- La suma de ambos cortes cuadra con el total de la sucursal
- Heartbeat de un terminal no afecta al otro
- Las ventas se filtran correctamente por `id_turno` (shift isolation)
  Y por rango de tiempo (temporal isolation)

#### Bloque 4: Repartidor — Ciclo Completo
Verifica el flujo completo de reparto.

- Cajero abre turno
- Asignar productos a repartidor (3 productos, diferentes unidades: kg, pz)
- Repartidor registra gasto desde móvil (Gasolina, $80) → `is_active=true` (pendiente revisión)
- Desktop aprueba gasto → sigue con `is_active=true`
- Repartidor devuelve producto parcial (2 de 5 kg Tortilla Maíz)
- Cambiar cliente en una asignación (cliente incorrecto → correcto)
- Liquidar: pago mixto (efectivo $200 + tarjeta $100 + crédito $50)
  - Crea ventas con `estado_venta_id=5` y `fecha_liquidacion_utc` dentro del turno
- Cerrar turno — el Scenario Builder auto-calcula y envía:
  - `totalLiquidacionesEfectivo = 200`
  - `totalLiquidacionesTarjeta = 100`
  - `totalLiquidacionesCredito = 50`
  - `totalRepartidorExpenses = 80`

**Assertions:**
- `totalKilosVendidos = asignados - devueltos`
- `montoTotalVendido = vendidos × precio`
- `netoAEntregar = montoVendido - gastos`
- Cambio de cliente se refleja en la asignación final
- Liquidaciones efectivo/tarjeta/crédito aparecen en el corte con los valores enviados
- Las ventas liquidadas (`estado_venta_id=5`) aparecen en los totales de ventas
  del corte (filtradas por `fecha_liquidacion_utc`)

#### Bloque 5: Repartidor — Flujo de Gastos
Verifica el workflow de aprobación/rechazo/edición de gastos.

- Repartidor envía gasto ($50, Combustible) → `is_active=true`
- Desktop rechaza gasto → `PUT /api/expenses/:global_id/deactivate` → `is_active=false`
- Repartidor reenvía corregido → nuevo registro, `is_active=true`
- Desktop edita monto ($45) y aprueba → `PATCH /api/expenses/:global_id` + `PATCH .../approve`
- Segundo gasto ($30, Comida) → Desktop aprueba directamente
- Cerrar turno

**Assertions:**
- Solo gastos con `is_active=true` ($45 + $30 = $75) aparecen en el corte
- Gasto rechazado (`is_active=false`) NO aparece
- Monto editado usa el valor corregido ($45, no $50)

#### Bloque 6: Consistencia Cross-Device
Verifica que todos los dispositivos ven los mismos números.

- Ejecuta el mismo escenario del Bloque 4
- Consulta el corte desde tres perspectivas:
  1. `GET /api/cash-cuts?shiftId=X` — como lo vería Terminal A
  2. `GET /api/cash-cuts?shiftId=X` — misma query desde Terminal B (otro JWT)
  3. `GET /api/cash-cuts?branch_id=X` — resumen de sucursal (todos los cortes)
- Compara los resultados

**Assertions (los tres deben ser idénticos para el mismo corte):**
- `total_cash_sales`, `total_card_sales`, `total_credit_sales`
- `total_expenses`, `total_deposits`, `total_withdrawals`
- `total_liquidaciones_efectivo`, `total_liquidaciones_tarjeta`, `total_liquidaciones_credito`
- `expected_cash_in_drawer`, `difference`

#### Bloque 7: Edge Cases — Modelo de Confianza de Liquidaciones
Verifica qué pasa cuando el cliente envía valores de liquidación incorrectos.

- Cajero abre turno, asigna a repartidor, liquida (efectivo $300)
- Cerrar turno enviando `totalLiquidacionesEfectivo = 999` (valor incorrecto a propósito)
- Verificar que el corte almacena $999, no $300

**Assertions:**
- El servidor almacena los valores de liquidación TAL CUAL los envía el cliente
- `expectedCashInDrawer` incluye los $999, no los $300 reales
- Este test documenta que las liquidaciones son un "trust the client" model.
  Si en el futuro el servidor valida las liquidaciones, este test fallará — señalando
  que el modelo cambió y los tests deben actualizarse.

## Cleanup y Seguridad de Datos

### Estrategia: Transaction Log + Borrado en Orden Inverso

El `ScenarioBuilder` trackea cada registro que crea (array en memoria) y los borra
en orden inverso de dependencias FK al terminar.

**Orden de borrado (nombres reales de tablas PostgreSQL):**
1. `cancelaciones_bitacora` (si hay ventas canceladas)
2. `credit_payments`
3. `ventas_detalle` → `ventas`
4. `repartidor_returns` → `repartidor_assignments`
5. `repartidor_liquidations`
6. `repartidor_debts` (creados automáticamente en liquidación con crédito)
7. `cash_cuts`
8. `expenses`
9. `deposits`
10. `withdrawals`
11. `shifts`

**Nunca se borran:** employees, productos, customers, branches (son datos seed permanentes).

### Identificación de Datos de Test

**Mecanismo primario:** Terminal IDs con prefijo `TEST-`. Todos los registros creados
por el test suite usan `terminal_id` con prefijo `TEST-` (`TEST-CAJA-A`, `TEST-CAJA-B`).
Producción nunca usa este prefijo.

El cleanup borra por `terminal_id LIKE 'TEST-%'` en cada tabla. Esto funciona en todas
las tablas offline-first (todas tienen `terminal_id`).

**Mecanismo secundario (donde esté disponible):** Tag en `device_event_raw`:

```json
{
  "test_run_id": "qa-run-2026-04-07-a1b2c3",
  "test_suite": "multi-caja-qa",
  "created_by": "automated-test"
}
```

No todas las tablas almacenan `device_event_raw` de forma confiable, por eso el mecanismo
primario es `terminal_id`.

### Guards de Seguridad

- **Terminal IDs con prefijo `TEST-`**: `TEST-CAJA-A`, `TEST-CAJA-B`. Producción nunca usa este prefijo.
- **Cleanup en `beforeAll` Y `afterAll`**: `beforeAll` limpia datos huérfanos de corridas previas fallidas.
- **Timeout safety**: Si cleanup falla, el test loguea los terminal IDs usados para limpiar manualmente:
  ```bash
  node scripts/cleanup/clean-test-run.js --terminal-prefix=TEST-
  ```
  Este script se crea como parte de la implementación.

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
PASS  tests/multi-caja-qa.test.js (55s)
  Single Terminal - Basic Operations
    ✓ corte matches expected cash/card/credit totals (3200ms)
    ✓ cancelled sale excluded from corte (1200ms)
    ✓ difference = counted - expected (850ms)
  Single Terminal - Discounts & Credit
    ✓ special price discount applied correctly (2100ms)
    ✓ credit sale excluded from cash drawer (1800ms)
    ✓ credit payment adds to cash drawer (1500ms)
    ✓ mixed payment (tipo_pago_id=4) excluded from all totals [KNOWN GAP] (1200ms)
  Multi-Caja Isolation
    ✓ Terminal A corte excludes Terminal B transactions (4200ms)
    ✓ Branch totals = sum of both cortes (1200ms)
  Repartidor Full Lifecycle
    ✓ liquidation totals: vendidos = asignados - devueltos (5500ms)
    ✓ client change reflected in final assignment (2100ms)
    ✓ liquidation cash/card/credit flow into corte (1800ms)
  Repartidor Expense Workflows
    ✓ rejected expense (is_active=false) excluded from corte (3200ms)
    ✓ edited expense uses corrected amount (2400ms)
  Cross-Device Consistency
    ✓ Terminal A corte === Terminal B query === branch summary (2800ms)
  Edge Cases - Trust Model
    ✓ server stores client-provided liquidation totals as-is (1500ms)

Test Suites: 1 passed, 1 total
Tests:       16 passed, 16 total
Cleanup:     12 shifts, 47 sales, 8 expenses deleted
```

### Output Esperado (fallo)

```
FAIL  Multi-Caja Isolation > Terminal A corte excludes Terminal B transactions
  Expected: total_cash_sales = 330
  Received: total_cash_sales = 440

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

## Referencia Rápida: Endpoints del Servidor Usados

| Operación | Método | Endpoint | Notas |
|-----------|--------|----------|-------|
| Abrir turno | POST | `/api/shifts/open` | Retorna shift con `start_time` |
| Cerrar turno | POST | `/api/cash-cuts` | Calcula totales del corte automáticamente |
| Consultar corte | GET | `/api/cash-cuts?shiftId=X` | Filtrable por `branch_id`, `is_closed` |
| Sync venta | POST | `/api/sync/ventas` | Incluye `ventas_detalle` |
| Sync gasto | POST | `/api/sync/expenses` | Acepta batch |
| Sync depósito | POST | `/api/sync/deposits` | Acepta batch |
| Sync retiro | POST | `/api/sync/withdrawals` | Acepta batch |
| Sync pago crédito | POST | `/api/sync/credit-payments` | Acepta batch |
| Aprobar gasto | PATCH | `/api/expenses/:global_id/approve` | Mantiene `is_active=true` |
| Rechazar gasto | PUT | `/api/expenses/:global_id/deactivate` | Pone `is_active=false` |
| Editar gasto | PATCH | `/api/expenses/:global_id` | Actualiza campos |
| Cancelar venta | POST | `/api/sync/cancelaciones` | Cambia `estado_venta_id` a 4 |
| Asignar repartidor | POST | `/api/sync/repartidor-assignments` | Acepta batch |
| Devolución | POST | `/api/sync/repartidor-returns` | Acepta batch |
| Liquidar | POST | `/api/sync/ventas` | Ventas con `estado_venta_id=5` |

## Glosario para Nuevos Colaboradores

| Término | Significado |
|---------|-------------|
| **Turno / Shift** | Período de trabajo de un cajero. Se abre con monto inicial, se cierra con corte de caja. Tiene `start_time` y `end_time` que definen el rango temporal para las queries del corte. |
| **Corte de Caja / Cash Cut** | Cierre del turno: el servidor suma todas las transacciones dentro del rango del turno y compara el efectivo esperado vs el contado físicamente. |
| **Multi-Caja** | Modo donde varias terminales (cajas) operan en la misma sucursal, cada una con su propio turno. |
| **Terminal** | Dispositivo físico (PC, tablet). Identificado por `terminal_id` (UUID derivado del hardware). |
| **Repartidor** | Empleado que sale a entregar producto. Lleva un inventario asignado y regresa con producto sobrante + dinero. |
| **Liquidación** | Proceso donde el cajero cuadra lo que el repartidor vendió vs lo que regresó vs lo que cobra. Las ventas de liquidación tienen `estado_venta_id=5` y usan `fecha_liquidacion_utc` para ubicarlas en el turno. |
| **Asignación** | Productos que se le dan al repartidor para vender en ruta. |
| **Devolución** | Producto que el repartidor no vendió y regresa. |
| **Gasto** | Dinero que sale de caja. Los repartidores registran gastos desde Flutter. El filtro del corte es `is_active=true` (no `status`). Rechazar un gasto pone `is_active=false`. |
| **Depósito** | Dinero que entra a caja (cambio del banco, etc.). |
| **Retiro** | Dinero que sale de caja (pago a proveedor, etc.). |
| **Offline-First** | Patrón donde los datos se crean localmente (SQLite) y se sincronizan al servidor (PostgreSQL) después. |
| **Server-First** | En multi-caja, los datos van primero al servidor para evitar conflictos entre terminales. |
| **`global_id`** | UUID único generado en el dispositivo. Garantiza idempotencia: si se sincroniza dos veces, no se duplica. |
| **`terminal_id`** | UUID del dispositivo. Los tests usan prefijo `TEST-` para distinguir datos de prueba. |
| **`tipo_pago_id`** | Tipo de pago: 1=Efectivo, 2=Tarjeta, 3=Crédito, 4=Mixto. El corte suma `SUM(total)` agrupado por este campo. Mixto (4) actualmente no se incluye en el corte (gap conocido). |
| **`estado_venta_id`** | Estado de la venta: 3=Completada, 4=Cancelada, 5=Liquidada (repartidor). Solo estados 3 y 5 cuentan en el corte. |
| **`is_active`** | Soft-delete boolean en gastos. `false` = rechazado/eliminado. El corte solo incluye gastos con `is_active=true`. |
| **Precio Especial** | Precio diferenciado por cliente y producto. El cliente "María" paga $20/kg en lugar de $22/kg. |
| **Descuento Global** | Descuento que aplica a todas las compras de un cliente (porcentaje o monto fijo). |
