# REFACTORING PLAN - SYA SocketIO Server

**Date:** 2025-10-24
**Current State:** Monolithic server.js (3012 lines)
**Goal:** Modular, maintainable, scalable architecture

---

## EXECUTIVE SUMMARY

### Current Issues
- **Monolithic server.js**: 3012 lines containing all endpoints
- **Mixed concerns**: Auth, business logic, and routing in one file
- **Code duplication**: Similar patterns across endpoints
- **Inconsistent patterns**: Some routes modular, others inline
- **Hard to test**: Tight coupling between components
- **Documentation sprawl**: 23 markdown files, many outdated

### Improvement Potential
- **50% reduction** in main file size
- **Better testability** through separation of concerns
- **Easier onboarding** with clear structure
- **Reduced bugs** through standardized patterns

---

## PART 1: ENDPOINT AUDIT

### 1.1 AUTHENTICATION ENDPOINTS (Desktop & Mobile)

#### Used By: Both Desktop + Mobile

| Endpoint | Method | Purpose | Status | Notes |
|----------|--------|---------|--------|-------|
| `/api/auth/google-signup` | POST | Desktop: Google OAuth registration | ✅ Active | Creates tenant + branch + employee |
| `/api/auth/check-email` | POST | Desktop: Check if email exists | ✅ Active | Returns branches if exists |
| `/api/auth/desktop-login` | POST | Desktop: Login with tenantCode + username + password | ✅ Active | Returns JWT token |
| `/api/auth/login` | POST | Mobile: Login with username/email + password | ✅ Active | Multi-branch support |
| `/api/auth/mobile-credentials-login` | POST | Mobile: Alias for /login | ⚠️ Redundant | Just redirects to /login |
| `/api/auth/scan-qr` | POST | Mobile: QR code device linking | ✅ Active | Device registration |
| `/api/auth/join-branch` | POST | Desktop: Create new branch | ✅ Active | Multi-branch setup |
| `/api/auth/refresh` | POST | Mobile: Refresh JWT tokens | ✅ Active | Token renewal |

**Issues:**
- ⚠️ `/api/auth/mobile-credentials-login` is redundant - just redirects to `/login`
- ⚠️ Auth logic duplicated across endpoints
- ⚠️ Password validation logic repeated

**Recommendation:**
- **Consolidate** mobile login endpoints into one
- **Extract** password validation to middleware
- **Standardize** response format (some use `isSuccess`, others use `success`)

---

### 1.2 TENANT & DATABASE MANAGEMENT

#### Used By: Admin/Debug

| Endpoint | Method | Purpose | Status | Notes |
|----------|--------|---------|--------|-------|
| `/health` | GET | Health check | ✅ Active | Database stats |
| `/api/version` | GET | API version info | ✅ Active | Debug endpoint |
| `/api/database/view` | GET | View all DB data | ⚠️ Debug | **SECURITY RISK** - no auth |
| `/api/database/fix-old-tenants` | POST | Fix missing subscription_id | ⚠️ Maintenance | One-time fix |
| `/api/database/delete-tenant-by-email` | POST | Delete tenant + all data | ⚠️ Dangerous | **NEEDS AUTH** |
| `/api/tenants/register` | POST | Register tenant (no OAuth) | ✅ Active | Desktop registration |

**Issues:**
- 🔴 `/api/database/view` has **NO authentication** - exposes all data
- 🔴 `/api/database/delete-tenant-by-email` has **NO authentication** - dangerous
- ⚠️ `/api/database/fix-old-tenants` is a one-time migration script - should be removed

**Recommendation:**
- **URGENT:** Add authentication to all `/api/database/*` endpoints
- **Remove** one-time fix endpoints after confirming all tenants are fixed
- **Move** to admin-only routes with role-based access

---

### 1.3 SALES ENDPOINTS

#### Used By: Both Desktop + Mobile

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/sales` | GET | List sales (paginated, filtered) | Mobile | ✅ Timezone-aware |
| `/api/sales` | POST | Create sale | Desktop | ❌ No auth required |
| `/api/sync/sales` | POST | Sync sale from Desktop | Desktop | ✅ Includes validation |
| `/api/sales-items` | GET | Get sale items | Mobile | Query by sale_id |
| `/api/sales-items/branch` | GET | Get items by branch | Mobile | Aggregated view |
| `/api/sales-items/by-type` | GET | Sales by product type | Mobile | Analytics |
| `/api/sales-items/by-payment` | GET | Sales by payment method | Mobile | Analytics |
| `/api/sales-items/stats` | GET | Sales statistics | Mobile | Dashboard |
| `/api/sync/sales-items` | POST | Sync sale items | Desktop | Line items sync |

**Issues:**
- ⚠️ **Duplicated logic**: We have BOTH `/api/sales` POST and `/api/sync/sales` POST
  - `/api/sales` POST: Simple insert (line 1376)
  - `/api/sync/sales` POST: More robust with date handling (line 1614)
- ⚠️ `/api/sales` POST has **NO authentication** (Desktop uses it)
- ⚠️ Response format inconsistency (some return `data`, others return `success`)

**Recommendation:**
- **Consolidate**: Use only `/api/sync/sales` for all sales creation
- **Deprecate**: `/api/sales` POST endpoint
- **Add auth**: Require JWT or API key for sales creation
- **Standardize**: All responses should use `{ success, data, message }` format

---

### 1.4 EXPENSES ENDPOINTS

#### Used By: Both Desktop + Mobile

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/expenses` | GET | List expenses (paginated) | Mobile | ✅ Timezone-aware |
| `/api/expenses` | POST | Create expense | Desktop | ❌ No auth |
| `/api/sync/expenses` | POST | Sync expense from Desktop | Desktop | ✅ Auto-creates categories |

**Issues:**
- ⚠️ **Same duplication** as sales: `/api/expenses` POST vs `/api/sync/expenses` POST
- ⚠️ `/api/expenses` POST has **NO authentication**

**Recommendation:**
- **Same as sales**: Consolidate into `/api/sync/expenses` only
- **Add auth** requirement

---

### 1.5 CASH CUTS (CORTES) ENDPOINTS

#### Used By: Both Desktop + Mobile

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/cash-cuts` | GET | List cash cuts | Mobile | ✅ Authenticated |
| `/api/cash-cuts` | POST | Create cash cut | Desktop | ✅ Authenticated |
| `/api/sync/cash-cuts` | POST | Sync cash cut from Desktop | Desktop | ✅ Robust |

**Issues:**
- ✅ Better than sales/expenses - only ONE POST endpoint exists
- ⚠️ Still has duplication with `/api/sync/cash-cuts`

**Recommendation:**
- **Consolidate** into `/api/sync/cash-cuts` only

---

### 1.6 SHIFT MANAGEMENT ENDPOINTS

#### Used By: Both Desktop + Mobile

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/shifts/open` | POST | Open shift | Mobile | ✅ Authenticated |
| `/api/shifts/close` | POST | Close shift | Mobile | ✅ Authenticated |
| `/api/shifts/current` | GET | Get current open shift | Mobile | ✅ Authenticated |
| `/api/shifts/history` | GET | Shift history | Mobile | ✅ Paginated |
| `/api/shifts/summary` | GET | Shift summary stats | Mobile | ✅ Analytics |
| `/api/shifts/:id/increment-counter` | PUT | Increment transaction counter | Mobile | ✅ Atomic update |
| `/api/sync/shifts/open` | POST | Sync shift open from Desktop | Desktop | ✅ Validation |

**Issues:**
- ⚠️ Duplication: `/api/shifts/open` vs `/api/sync/shifts/open`
- ✅ Good pattern: RESTful endpoints
- ⚠️ No `/api/sync/shifts/close` endpoint (inconsistent)

**Recommendation:**
- **Add** `/api/sync/shifts/close` for consistency
- **Keep both** patterns (mobile uses REST, desktop uses sync)
- **Document** the distinction clearly

---

### 1.7 PURCHASES ENDPOINTS

#### Used By: Desktop

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/purchases` | GET | List purchases | Mobile | ✅ Authenticated |
| `/api/purchases` | POST | Create purchase | Desktop | ❌ No auth |
| `/api/sync/purchases` | POST | Sync purchase from Desktop | Desktop | ✅ Validation |

**Issues:**
- ⚠️ Same duplication pattern

**Recommendation:**
- **Consolidate** into `/api/sync/purchases`

---

### 1.8 GUARDIAN EVENTS ENDPOINTS

#### Used By: Mobile (Security alerts)

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/guardian-events` | GET | List security events | Mobile | ✅ Authenticated |
| `/api/guardian-events` | POST | Create event | Desktop | ✅ Authenticated |
| `/api/guardian-events/:id/mark-read` | PUT | Mark event as read | Mobile | ✅ Authenticated |

**Issues:**
- ✅ Well-designed, no issues

---

### 1.9 BRANCH MANAGEMENT

#### Used By: Both

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/branches` | GET | List branches (line 2323) | Mobile | ✅ Authenticated |
| `/api/branches` | POST | Create branch (line 2350) | Admin | ✅ Authenticated |
| `/api/branches` | GET | List branches (line 2391) | Mobile | ⚠️ **DUPLICATE** |

**Issues:**
- 🔴 **DUPLICATE ENDPOINT**: `/api/branches` GET appears TWICE (lines 2323 and 2391)
- ⚠️ They do the same thing but with slightly different queries

**Recommendation:**
- **Remove** one of the duplicate GET endpoints
- **Consolidate** logic into one

---

### 1.10 DASHBOARD ENDPOINT

#### Used By: Mobile

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/dashboard/summary` | GET | Dashboard aggregates | Mobile | ✅ Timezone-aware |

**Issues:**
- ✅ Well-designed
- ⚠️ Complex date filtering logic could be extracted

---

### 1.11 REPARTIDOR (DELIVERY) SYSTEM

#### Location: `routes/repartidor_assignments.js`, `routes/repartidor_debts.js`

| Endpoint | Method | Purpose | Used By | Notes |
|----------|--------|---------|---------|-------|
| `/api/repartidor-assignments` | POST | Create assignment | Desktop | ✅ Modular |
| `/api/repartidor-assignments/:id/liquidate` | POST | Liquidate assignment | Desktop | ✅ Modular |
| `/api/repartidor-assignments/employee/:id` | GET | Get employee assignments | Mobile | ✅ Modular |
| `/api/repartidor-liquidations/employee/:id` | GET | Get liquidations | Mobile | ✅ Modular |
| `/api/repartidor-liquidations/branch/:id/summary` | GET | Branch summary | Admin | ✅ Modular |
| `/api/repartidor-debts` | Various | Debt management | Both | ✅ Modular |

**Issues:**
- ✅ **EXCELLENT EXAMPLE** of modular design
- ✅ Separated into own files
- ✅ Uses Socket.IO for real-time updates

**Recommendation:**
- **Use as template** for refactoring other endpoints

---

### 1.12 BACKUP & RESTORE SYSTEM

#### Location: `routes/backup.js`, `routes/restore.js`

| Route Module | Endpoints | Purpose | Notes |
|--------------|-----------|---------|-------|
| `/api/backup` | Multiple | Cloud backup system | ✅ Modular |
| `/api/restore` | Multiple | Cloud restore system | ✅ Modular |

**Issues:**
- ✅ Well-organized
- ✅ Separated from main server

---

### 1.13 NOTIFICATION SYSTEM

#### Location: `routes/notifications.js`

| Route Module | Endpoints | Purpose | Notes |
|--------------|-----------|---------|-------|
| `/api/notifications` | Multiple | FCM push notifications | ✅ Modular |

**Issues:**
- ✅ Good separation
- ✅ Firebase integration isolated

---

## PART 2: HELPER FUNCTIONS & UTILITIES

### 2.1 Middleware Functions

| Function | Location | Purpose | Called By | Status |
|----------|----------|---------|-----------|--------|
| `authenticateToken` | server.js:1158 | JWT validation | Most endpoints | ✅ Used extensively |
| `startServer` | server.js:2971 | Server initialization | Startup | ✅ Active |

**Issues:**
- ⚠️ Only TWO helper functions in 3012 lines
- ⚠️ No validation middleware
- ⚠️ No error handling middleware
- ⚠️ No request logging middleware

**Recommendation:**
- **Create** `middleware/` folder with:
  - `auth.js` - JWT validation
  - `validation.js` - Request validation
  - `errorHandler.js` - Centralized error handling
  - `logger.js` - Request/response logging

---

### 2.2 Dead Code Analysis

**Searched for unused functions:**
- ✅ No dead functions detected
- ✅ All functions are called

**Potentially obsolete:**
- ⚠️ `/api/database/fix-old-tenants` - One-time migration
- ⚠️ `/api/auth/mobile-credentials-login` - Just a redirect

---

## PART 3: SOCKET.IO EVENTS

### Real-time Events (Lines 2787-2965)

| Event | Purpose | Emitted By | Listened By | Notes |
|-------|---------|------------|-------------|-------|
| `join_branch` | Join room for branch | Client | Server | ✅ Core |
| `identify_client` | Desktop/Mobile identification | Client | Server | ✅ Core |
| `scale_alert` | Básculas alerts | Desktop | Mobile | ✅ Core |
| `scale_disconnected` | Básculas offline | Desktop | Mobile | ✅ Core |
| `scale_connected` | Básculas online | Desktop | Mobile | ✅ Core |
| `sale_completed` | Sale finished | Desktop | Mobile | ✅ Core |
| `weight_update` | Real-time weight | Desktop | Mobile | ✅ Core |
| `shift_started` | Shift opened | Desktop | Mobile | ✅ + DB sync |
| `shift_ended` | Shift closed | Desktop | Mobile | ✅ + DB sync |
| `user-login` | User logged in | Server | All clients | ✅ Broadcast |
| `get_stats` | Server stats | Client | Server | ✅ Monitoring |

**Issues:**
- ✅ Well-designed event system
- ✅ Good integration with PostgreSQL
- ✅ FCM notifications on key events

---

## PART 4: DOCUMENTATION ANALYSIS

### 4.1 Currently Relevant Documentation

| File | Purpose | Status | Keep? |
|------|---------|--------|-------|
| `README.md` | Main project docs | ✅ Current | ✅ Keep |
| `SECURITY.md` | Security guidelines | ✅ Current | ✅ Keep |
| `TIMEZONE_FIX_INSTRUCTIONS.md` | Phase 2 timezone fixes | ✅ Current | ✅ Keep |
| `PHASE1_TIMEZONE_UPDATES.md` | Phase 1 applied | ✅ Reference | ✅ Keep |
| `INSTRUCTIONS_REPARTIDOR_ASSIGNMENTS.md` | Repartidor setup | ✅ Current | ✅ Keep |
| `TESTING_FCM.md` | FCM testing guide | ✅ Current | ✅ Keep |
| `SHIFT_SYNC_IMPLEMENTATION.md` | Shift sync docs | ✅ Current | ✅ Keep |
| `QUICK_SETUP_GUIDE.md` | Setup instructions | ✅ Current | ✅ Keep |

**Total: 8 files to keep**

---

### 4.2 Outdated/Obsolete Documentation

| File | Purpose | Status | Action |
|------|---------|--------|--------|
| `COMPLETE_FIX_SUMMARY.md` | Oct 21 fix summary | ⚠️ Historical | 📁 Archive |
| `DESKTOP_SYNC_STATUS.md` | Desktop sync status | ⚠️ Completed | 📁 Archive |
| `DIAGNOSTICO_KEY_NOT_FOUND.md` | Key error diagnosis | ⚠️ Fixed | 🗑️ Delete |
| `DUPLICATE_TICKETS_ANALYSIS.md` | Duplicate tickets | ⚠️ Fixed | 📁 Archive |
| `FINDINGS_SUMMARY.md` | Sync issues found | ⚠️ Fixed | 🗑️ Delete |
| `FIX_SYNC_ISSUES.md` | Sync fix guide | ⚠️ Fixed | 🗑️ Delete |
| `MOBILE_APP_ERROR_FIX.md` | SQL param bug | ⚠️ Fixed | 🗑️ Delete |
| `NEXT_STEPS.md` | Action plan | ⚠️ Completed | 🗑️ Delete |
| `SYNC_ERROR_ANALYSIS.md` | Sync error details | ⚠️ Fixed | 🗑️ Delete |
| `README_SYNC_ISSUE.md` | Sync issue readme | ⚠️ Fixed | 🗑️ Delete |
| `SESSION_SUMMARY_OCTOBER_22.md` | Oct 22 session | ⚠️ Historical | 📁 Archive |
| `REPARTIDOR_ASSIGNMENTS_IMPLEMENTATION_SUMMARY.md` | Implementation summary | ⚠️ Superseded | 🗑️ Delete |
| `REPARTIDOR_SYSTEM_IMPLEMENTATION_COMPLETE.md` | Completion notice | ⚠️ Superseded | 🗑️ Delete |
| `SALES_TABLE_DOCUMENTATION.md` | Sales table docs | ⚠️ Outdated | ✅ Update & Keep |
| `RENDER_ENV_UPDATE_INSTRUCTIONS.md` | Env var setup | ✅ Current | ✅ Keep |

**Actions:**
- **Delete:** 9 files (fixed issues, no longer relevant)
- **Archive:** 3 files (historical reference)
- **Update:** 1 file (SALES_TABLE_DOCUMENTATION.md)

---

### 4.3 Duplicate/Contradictory Information

**Timezone Documentation:**
- ✅ `TIMEZONE_FIX_INSTRUCTIONS.md` - Phase 2 (current)
- ✅ `PHASE1_TIMEZONE_UPDATES.md` - Phase 1 (reference)
- **Status:** Not contradictory, sequential

**Sync Issue Documentation:**
- ⚠️ 6 different files about sync issues (all fixed)
- **Action:** Delete all, keep only main README

**Repartidor Documentation:**
- ⚠️ 3 files about repartidor system
- **Action:** Keep only `INSTRUCTIONS_REPARTIDOR_ASSIGNMENTS.md`

---

## PART 5: PROPOSED REFACTORING

### 5.1 New Folder Structure

```
sya-socketio-server/
├── server.js                      (100-150 lines - just setup & routing)
├── database.js                    (existing - keep)
├── .env
├── package.json
│
├── config/
│   ├── constants.js              (JWT_SECRET, ALLOWED_ORIGINS, etc.)
│   └── database.js               (pool config)
│
├── middleware/
│   ├── auth.js                   (authenticateToken, requireRole)
│   ├── validation.js             (validate request bodies)
│   ├── errorHandler.js           (centralized error handling)
│   └── logger.js                 (request/response logging)
│
├── routes/
│   ├── index.js                  (aggregate all routes)
│   ├── auth.js                   (EXISTING - already modular)
│   ├── backup.js                 (EXISTING - keep)
│   ├── restore.js                (EXISTING - keep)
│   ├── notifications.js          (EXISTING - keep)
│   ├── repartidor_assignments.js (EXISTING - keep)
│   ├── repartidor_debts.js       (EXISTING - keep)
│   ├── sales.js                  (NEW - extract from server.js)
│   ├── expenses.js               (NEW - extract from server.js)
│   ├── shifts.js                 (NEW - extract from server.js)
│   ├── cashCuts.js               (NEW - extract from server.js)
│   ├── purchases.js              (NEW - extract from server.js)
│   ├── guardian.js               (NEW - extract from server.js)
│   ├── branches.js               (EXISTING - keep)
│   ├── tenants.js                (EXISTING - keep)
│   ├── dashboard.js              (NEW - extract from server.js)
│   └── admin.js                  (NEW - database management endpoints)
│
├── controllers/
│   ├── salesController.js        (business logic)
│   ├── expensesController.js
│   ├── shiftsController.js
│   ├── authController.js
│   └── ... (one per domain)
│
├── services/
│   ├── salesService.js           (database operations)
│   ├── expensesService.js
│   ├── authService.js
│   └── notificationService.js
│
├── models/
│   ├── Sale.js
│   ├── Expense.js
│   ├── Shift.js
│   └── ... (data models)
│
├── utils/
│   ├── responseFormatter.js      (standardize responses)
│   ├── dateHelpers.js            (timezone utilities)
│   ├── validators.js             (input validation)
│   ├── runMigrations.js          (EXISTING - keep)
│   ├── firebaseAdmin.js          (EXISTING - keep)
│   └── notificationHelper.js     (EXISTING - keep)
│
├── socket/
│   ├── index.js                  (Socket.IO setup)
│   ├── events.js                 (event handlers)
│   └── rooms.js                  (room management)
│
├── migrations/
│   └── *.sql                     (database migrations)
│
├── tests/
│   ├── auth.test.js
│   ├── sales.test.js
│   └── ... (unit tests)
│
└── docs/
    ├── API.md                    (API documentation)
    ├── ARCHITECTURE.md           (system architecture)
    ├── SETUP.md                  (setup guide)
    ├── TIMEZONE.md               (timezone documentation)
    ├── REPARTIDOR.md             (repartidor system)
    └── archive/                  (old docs)
        ├── COMPLETE_FIX_SUMMARY.md
        ├── DESKTOP_SYNC_STATUS.md
        └── SESSION_SUMMARY_OCTOBER_22.md
```

---

### 5.2 Endpoint Consolidation Plan

#### Phase 1: Remove Duplicates (1-2 hours)

**1. Consolidate Sales Endpoints**
- ❌ Remove: `POST /api/sales` (line 1376)
- ✅ Keep: `POST /api/sync/sales` (line 1614)
- **Update:** Desktop app to use `/api/sync/sales`

**2. Consolidate Expenses Endpoints**
- ❌ Remove: `POST /api/expenses` (line 1506)
- ✅ Keep: `POST /api/sync/expenses` (line 1975)
- **Update:** Desktop app to use `/api/sync/expenses`

**3. Consolidate Purchases Endpoints**
- ❌ Remove: `POST /api/purchases` (line 2133)
- ✅ Keep: `POST /api/sync/purchases` (line 2169)

**4. Remove Duplicate Branch Endpoint**
- ❌ Remove: One of the `GET /api/branches` (line 2391 or 2323)
- ✅ Keep: Better implementation

**5. Remove Redundant Auth Endpoint**
- ❌ Remove: `POST /api/auth/mobile-credentials-login`
- **Update:** Mobile app to use `/api/auth/login` directly

---

#### Phase 2: Add Authentication (2-3 hours)

**Secure these endpoints:**
- `POST /api/sales` (if kept)
- `POST /api/expenses` (if kept)
- `GET /api/database/view` ← **CRITICAL**
- `POST /api/database/delete-tenant-by-email` ← **CRITICAL**
- `POST /api/database/fix-old-tenants`

**Add role-based access:**
- Admin-only: Database management endpoints
- Owner-only: Tenant deletion
- Employee: Regular operations

---

#### Phase 3: Extract to Modules (4-6 hours)

**Week 1:**
- Extract `/api/sales*` → `routes/sales.js`
- Extract `/api/expenses*` → `routes/expenses.js`
- Extract `/api/shifts*` → `routes/shifts.js`

**Week 2:**
- Extract `/api/cash-cuts*` → `routes/cashCuts.js`
- Extract `/api/purchases*` → `routes/purchases.js`
- Extract `/api/guardian-events*` → `routes/guardian.js`

**Week 3:**
- Extract `/api/dashboard*` → `routes/dashboard.js`
- Extract `/api/database*` → `routes/admin.js`
- Create middleware folder

---

#### Phase 4: Standardize Responses (2-3 hours)

**Current inconsistencies:**
- Some return `{ success, data, message }`
- Some return `{ isSuccess, errorMessage }`
- Some return `{ success, error }`

**Standardize to:**
```javascript
{
  success: boolean,
  data?: any,
  message?: string,
  error?: string (only in development)
}
```

**Create utility:**
```javascript
// utils/responseFormatter.js
const success = (data, message) => ({ success: true, data, message });
const error = (message, statusCode = 500) => ({ success: false, message, statusCode });
```

---

#### Phase 5: Add Validation Middleware (3-4 hours)

**Create validators for:**
- Auth requests (email, password, etc.)
- Sales creation (tenantId, branchId, amount)
- Date range queries
- Pagination parameters

**Example:**
```javascript
// middleware/validation.js
const validateSaleCreation = (req, res, next) => {
  const { tenantId, branchId, totalAmount } = req.body;
  if (!tenantId || !branchId || !totalAmount) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  next();
};
```

---

#### Phase 6: Extract Socket.IO (2-3 hours)

**Move to `socket/` folder:**
- `socket/index.js` - Setup & configuration
- `socket/events.js` - Event handlers
- `socket/rooms.js` - Room management

**Benefits:**
- Easier to test
- Clearer separation
- Better documentation

---

### 5.3 Priority Order

**🔴 CRITICAL (Do First - 1 day)**
1. Add authentication to `/api/database/*` endpoints ← **SECURITY RISK**
2. Remove redundant endpoints (sales, expenses, purchases duplicates)
3. Fix duplicate `/api/branches` GET endpoint

**🟡 HIGH (Week 1-2)**
4. Extract sales endpoints to `routes/sales.js`
5. Extract expenses endpoints to `routes/expenses.js`
6. Extract shifts endpoints to `routes/shifts.js`
7. Create middleware folder (auth, validation, error handling)

**🟢 MEDIUM (Week 3-4)**
8. Standardize response format across all endpoints
9. Add validation middleware
10. Extract remaining endpoints to modules
11. Create comprehensive API documentation

**🔵 LOW (Month 2)**
12. Add unit tests
13. Extract Socket.IO to modules
14. Create controllers layer
15. Add request/response logging

---

## PART 6: CLEANUP RECOMMENDATIONS

### 6.1 Files to Delete (Safe to Remove)

```bash
# Fixed issues - no longer needed
rm DIAGNOSTICO_KEY_NOT_FOUND.md
rm FINDINGS_SUMMARY.md
rm FIX_SYNC_ISSUES.md
rm MOBILE_APP_ERROR_FIX.md
rm NEXT_STEPS.md
rm SYNC_ERROR_ANALYSIS.md
rm README_SYNC_ISSUE.md
rm REPARTIDOR_ASSIGNMENTS_IMPLEMENTATION_SUMMARY.md
rm REPARTIDOR_SYSTEM_IMPLEMENTATION_COMPLETE.md
```

---

### 6.2 Files to Archive (Historical Reference)

```bash
mkdir docs/archive
mv COMPLETE_FIX_SUMMARY.md docs/archive/
mv DESKTOP_SYNC_STATUS.md docs/archive/
mv SESSION_SUMMARY_OCTOBER_22.md docs/archive/
```

---

### 6.3 Files to Update

**`SALES_TABLE_DOCUMENTATION.md`**
- Update with current schema
- Add timezone handling notes
- Document relationship with repartidor_assignments

**`README.md`**
- Add refactoring status
- Document new folder structure
- Update setup instructions

---

### 6.4 Code to Remove from server.js

**One-time migrations:**
```javascript
// Line 121: /api/database/fix-old-tenants
// This was a one-time fix - safe to remove after confirming all tenants have subscription_id
```

**Redundant endpoints:**
```javascript
// Line 897: /api/auth/mobile-credentials-login - just redirects
// Line 1376: POST /api/sales - duplicate of /api/sync/sales
// Line 1506: POST /api/expenses - duplicate of /api/sync/expenses
// Line 2133: POST /api/purchases - duplicate of /api/sync/purchases
// Line 2391: GET /api/branches - duplicate
```

---

## PART 7: TESTING STRATEGY

### 7.1 Before Refactoring
- [ ] Document all current endpoint behaviors
- [ ] Create integration test suite
- [ ] Test all endpoints with Postman/automated tests
- [ ] Backup production database

### 7.2 During Refactoring
- [ ] Refactor one domain at a time
- [ ] Test after each module extraction
- [ ] Keep old code commented until verified
- [ ] Run full test suite after each change

### 7.3 After Refactoring
- [ ] Full regression testing
- [ ] Load testing
- [ ] Security audit
- [ ] Update all documentation

---

## PART 8: IMPLEMENTATION TIMELINE

### Week 1: Critical Security & Duplicates
- **Day 1-2:** Add auth to `/api/database/*`, remove duplicate endpoints
- **Day 3-4:** Extract sales & expenses to modules
- **Day 5:** Testing & deployment

### Week 2: Shifts & Cash Cuts
- **Day 1-2:** Extract shifts endpoints
- **Day 3-4:** Extract cash cuts & purchases
- **Day 5:** Testing & deployment

### Week 3: Middleware & Validation
- **Day 1-2:** Create middleware folder
- **Day 3-4:** Add validation to all endpoints
- **Day 5:** Testing & deployment

### Week 4: Documentation & Cleanup
- **Day 1-2:** Standardize responses
- **Day 3-4:** Update documentation
- **Day 5:** Final testing & deployment

---

## PART 9: ROLLBACK PLAN

**If something breaks:**
1. Git revert to last working commit
2. Deploy previous version to Render
3. Restore database backup if needed
4. Document what went wrong
5. Fix in development environment
6. Re-test before re-deploying

**Git strategy:**
```bash
# Create feature branch for each phase
git checkout -b refactor/phase1-security
# Make changes
git commit -m "feat: Add auth to database endpoints"
git push origin refactor/phase1-security
# Create PR, review, merge
# Repeat for each phase
```

---

## PART 10: SUCCESS METRICS

**Before Refactoring:**
- Lines in server.js: 3012
- Number of route files: 9
- Duplicate endpoints: 5+
- Endpoints without auth: 8+
- Documentation files: 23
- Test coverage: 0%

**After Refactoring (Goals):**
- Lines in server.js: < 200
- Number of route files: 15+
- Duplicate endpoints: 0
- Endpoints without auth: 0 (except public endpoints)
- Documentation files: 10 (+ archive)
- Test coverage: > 70%

**Improvement:**
- 93% reduction in server.js size
- 100% removal of duplicates
- 100% authentication coverage
- 43% reduction in doc files
- 70% test coverage (new)

---

## CONCLUSION

**Current State:** Functional but monolithic, with security concerns and maintainability issues.

**Proposed State:** Modular, secure, well-documented, testable.

**Estimated Effort:** 4 weeks (1 developer, part-time)

**Risk Level:** Medium (with proper testing and rollback plan)

**Recommended Approach:** Incremental refactoring, one domain at a time, with full testing between phases.

**Next Steps:**
1. Review this plan with team
2. Prioritize phases based on business needs
3. Create feature branch
4. Begin Phase 1 (Critical Security)
