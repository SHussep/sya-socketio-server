# Onboarding Device Mode Selection - Design Spec

## Goal

Add a 4th step to the Desktop WelcomePage onboarding where new users choose their device operation mode: **Single Device** (offline-first) or **Multi-Caja** (server-first, multi-device). This decision currently lives buried in Settings and most users never find it.

## Context

- Desktop WelcomePage currently has 3 steps: Gmail Auth → Business Info → Password
- Multi-caja toggle currently lives in Settings → Devices, defaulting to `false`
- The backend already supports `PUT /api/branches/:id/settings` with `multi_caja_enabled`
- The local setting key is `MultiCajaEnabled_{tenantId}_{branchId}`

## Scope

- **Desktop only** — WelcomePage is a Desktop WinUI feature
- **Backend** — no changes needed, existing endpoint works
- **Flutter** — no changes needed, reads `multi_caja_enabled` from backend on shift open

## Design

### Step 4: Device Mode Selection

Appears after Step 3 (password) and before registration finalizes. The "COMENZAR PRUEBA GRATIS" button moves from Step 3 to Step 4.

#### Layout

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   ¿Cómo usarás tu punto de venta?                  │
│   Elige el modo que mejor se adapte a tu negocio    │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │  🖥️  [selected]  │  │  🖥️🖥️            │         │
│  │                  │  │                  │         │
│  │ Un solo          │  │ Multi-caja       │         │
│  │ dispositivo      │  │          [badge] │         │
│  │                  │  │ Requiere internet│         │
│  │ Cobra desde una  │  │                  │         │
│  │ sola computadora.│  │ Cobra desde      │         │
│  │ Funciona sin     │  │ varios           │         │
│  │ internet.        │  │ dispositivos al  │         │
│  │                  │  │ mismo tiempo.    │         │
│  │ ✓ 100% offline   │  │                  │         │
│  │ ✓ Un punto de    │  │ ✓ 2+ cajas       │         │
│  │   cobro          │  │   simultáneas    │         │
│  │ ✓ Datos locales  │  │ ✓ Sincronización │         │
│  │                  │  │   en tiempo real │         │
│  │ ⚠ Solo puedes    │  │ ✓ Computadora o  │         │
│  │ cobrar en un     │  │   celular        │         │
│  │ dispositivo      │  │                  │         │
│  │ a la vez         │  │ ⚠ Requiere       │         │
│  │                  │  │ conexión estable │         │
│  └──────────────────┘  └──────────────────┘         │
│                                                     │
│  Puedes cambiar esto después en                     │
│  Configuración → Dispositivos.                      │
│  Para desactivar multi-caja, todos los turnos       │
│  deben estar cerrados.                              │
│                                                     │
│         [ COMENZAR PRUEBA GRATIS ]                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

#### Visual Specs

- **Two cards side by side**, equal width, with rounded corners and border
- **Selected card**: accent-color border (teal/cyan matching app theme), slightly elevated
- **Unselected card**: subtle border, dimmed
- **Default selection**: "Un solo dispositivo" (left card)
- **Badge on Multi-caja**: small pill/tag "Requiere internet" in orange/yellow
- **Warning text** (⚠): yellow/amber color, smaller font
- **Footer text**: gray, smaller font
- **Cards are clickable** — clicking toggles selection

#### Behavior

1. **Default**: "Un solo dispositivo" preselected
2. **Selection**: Clicking a card selects it, deselects the other (radio behavior)
3. **Multi-caja selected + no internet**: On clicking "COMENZAR PRUEBA GRATIS", show toast/info bar: "Se requiere conexión a internet para activar el modo Multi-caja. Verifica tu conexión e intenta de nuevo." Keep user on this step.
4. **Registration flow**: After clicking the button:
   - Run the existing registration flow (create tenant, branch, employee in backend)
   - After successful registration, save the device mode:
     - Local: `MultiCajaEnabled_{tenantId}_{branchId}` = `true/false`
     - Backend: `PUT /api/branches/{branchId}/settings` with `{ multi_caja_enabled: true/false }`
   - If backend sync fails → save locally, will sync later (non-blocking)
   - Navigate to LoginPage

#### Step Navigation Changes

- Step 3 loses its "COMENZAR PRUEBA GRATIS" button — it becomes a "Siguiente" (Next) button that advances to Step 4
- Step 4 has "COMENZAR PRUEBA GRATIS" as its primary action
- Back button on Step 4 returns to Step 3

## Files to Modify

| File | Change |
|------|--------|
| `Views/WelcomePage.xaml` | Add Step 4 panel with two card layout |
| `Views/WelcomePage.xaml.cs` | Handle Step 4 navigation, card selection, internet check |
| `ViewModels/WelcomeViewModel.cs` | Add `SelectedDeviceMode` property, save setting after registration |

## What This Does NOT Change

- Backend endpoints (already exist)
- Flutter behavior (already reads `multi_caja_enabled` from backend)
- Settings page toggle (still works for changing mode later)
- Registration flow logic (unchanged, just adds one setting save after)

## Constraints

- **Activating multi-caja**: No restrictions, can be done anytime
- **Deactivating multi-caja later**: Backend rejects if there are open shifts (`409 Conflict`)
- **Internet check**: Only required when selecting multi-caja, not for single device
- **Default**: Single device (offline-first) — safest option for new users
