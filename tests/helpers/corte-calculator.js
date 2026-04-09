// tests/helpers/corte-calculator.js
//
// Pure function that calculates expected corte values from a transaction log.
// Replicates the SQL logic from routes/cash-cuts.js lines 162-262.
// If the server logic changes, update this file to match.

/**
 * @typedef {Object} Transaction
 * @property {'sale'|'expense'|'deposit'|'withdrawal'|'credit_payment'|'liquidation'} type
 * @property {number} amount - For sale: total. For others: amount.
 * @property {number} [tipoPagoId] - 1=Cash, 2=Card, 3=Credit, 4=Mixed. Used for sales.
 * @property {number} [estadoVentaId] - 3=Completed, 4=Cancelled, 5=Liquidated.
 * @property {string} [paymentMethod] - 'cash' or 'card'. Used for credit_payments.
 * @property {boolean} [isActive] - For expenses. Only is_active=true count.
 * @property {number} [cashAmount] - For liquidation breakdowns.
 * @property {number} [cardAmount] - For liquidation breakdowns.
 * @property {number} [creditAmount] - For liquidation breakdowns.
 * @property {boolean} [isRepartidorExpense] - True if expense belongs to repartidor.
 */

/**
 * Calculate expected corte values from a list of transactions.
 *
 * @param {number} initialAmount - Shift starting cash.
 * @param {Transaction[]} transactions - All transactions within the shift.
 * @param {number} countedCash - Physical cash counted at close.
 * @returns {Object} Expected corte values.
 */
function calculateExpectedCorte(initialAmount, transactions, countedCash) {
    let totalCashSales = 0;
    let totalCardSales = 0;
    let totalCreditSales = 0;
    let totalExpenses = 0;
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalCashPayments = 0;
    let totalCardPayments = 0;
    let totalLiquidacionesEfectivo = 0;
    let totalLiquidacionesTarjeta = 0;
    let totalLiquidacionesCredito = 0;
    let totalRepartidorExpenses = 0;

    for (const tx of transactions) {
        switch (tx.type) {
            case 'sale': {
                // Only completed (3) and liquidated (5) sales count
                if (tx.estadoVentaId === 4) continue; // Cancelled — skip
                if (tx.estadoVentaId !== 3 && tx.estadoVentaId !== 5) continue;

                switch (tx.tipoPagoId) {
                    case 1: totalCashSales += tx.amount; break;
                    case 2: totalCardSales += tx.amount; break;
                    case 3: totalCreditSales += tx.amount; break;
                    // tipo_pago_id=4 (Mixed) is NOT handled by the server — excluded from all totals
                    default: break;
                }
                break;
            }
            case 'expense': {
                if (tx.isActive === false) continue; // Rejected/deactivated — skip
                totalExpenses += tx.amount;
                if (tx.isRepartidorExpense) {
                    totalRepartidorExpenses += tx.amount;
                }
                break;
            }
            case 'deposit': {
                totalDeposits += tx.amount;
                break;
            }
            case 'withdrawal': {
                totalWithdrawals += tx.amount;
                break;
            }
            case 'credit_payment': {
                if (tx.paymentMethod === 'cash') {
                    totalCashPayments += tx.amount;
                } else if (tx.paymentMethod === 'card') {
                    totalCardPayments += tx.amount;
                }
                break;
            }
            case 'liquidation': {
                // Liquidation totals are client-provided values sent to POST /api/cash-cuts
                totalLiquidacionesEfectivo += tx.cashAmount || 0;
                totalLiquidacionesTarjeta += tx.cardAmount || 0;
                totalLiquidacionesCredito += tx.creditAmount || 0;
                break;
            }
        }
    }

    // Formula from routes/cash-cuts.js line 262:
    // expectedCash = initial + cashSales + cashPayments + liqEfectivo + deposits - expenses - withdrawals
    const expectedCashInDrawer = initialAmount
        + totalCashSales
        + totalCashPayments
        + totalLiquidacionesEfectivo
        + totalDeposits
        - totalExpenses
        - totalWithdrawals;

    const difference = countedCash - expectedCashInDrawer;

    return {
        initialAmount,
        totalCashSales,
        totalCardSales,
        totalCreditSales,
        totalCashPayments,
        totalCardPayments,
        totalExpenses,
        totalDeposits,
        totalWithdrawals,
        totalLiquidacionesEfectivo,
        totalLiquidacionesTarjeta,
        totalLiquidacionesCredito,
        totalRepartidorExpenses,
        expectedCashInDrawer,
        countedCash,
        difference
    };
}

module.exports = { calculateExpectedCorte };
