# Onboarding Device Mode Selection - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Step 4 to Desktop WelcomePage where users choose between Single Device (offline-first) and Multi-Caja (server-first) before completing registration.

**Architecture:** The existing 3-step wizard (Gmail → Business → Password) gets a 4th step with two selectable cards. The "COMENZAR PRUEBA GRATIS" button moves from Step 3 to Step 4. After registration completes, the selected mode is saved locally and synced to the backend via the existing `PUT /api/branches/:id/settings` endpoint.

**Tech Stack:** WinUI 3 / XAML / C# / CommunityToolkit.Mvvm

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `ViewModels/WelcomeViewModel.cs` | Wizard state, step navigation, registration | Modify: add Step 4 visibility, mode selection property, save mode after registration |
| `Views/WelcomePage.xaml` | Wizard UI layout | Modify: add Step 4 stepper indicator, Step 4 panel with two cards, move register button |
| `Views/WelcomePage.xaml.cs` | Code-behind event handlers | Modify: add card click handlers (if needed beyond x:Bind) |

No new files needed. No backend changes needed.

---

## Task 1: Add Step 4 properties to WelcomeViewModel

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\WelcomeViewModel.cs`

- [ ] **Step 1: Add IsStep4Visible property and MultiCajaSelected property**

After the existing `_isStep3Visible` field (line 359), add:

```csharp
[ObservableProperty]
private bool _isStep4Visible = false;

[ObservableProperty]
private bool _multiCajaSelected = false; // false = single device (default)
```

- [ ] **Step 2: Update OnCurrentStepChanged to include Step 4**

Change the `OnCurrentStepChanged` method (line 361-366) from:

```csharp
partial void OnCurrentStepChanged(int value)
{
    IsStep1Visible = value == 1;
    IsStep2Visible = value == 2;
    IsStep3Visible = value == 3;
}
```

To:

```csharp
partial void OnCurrentStepChanged(int value)
{
    IsStep1Visible = value == 1;
    IsStep2Visible = value == 2;
    IsStep3Visible = value == 3;
    IsStep4Visible = value == 4;
}
```

- [ ] **Step 3: Update NextStep to allow step 3 → 4**

Change `NextStep()` (line 373-380) from:

```csharp
private void NextStep()
{
    if (CurrentStep < 3)
    {
        CurrentStep++;
        ErrorMessage = string.Empty;
    }
}
```

To:

```csharp
private void NextStep()
{
    if (CurrentStep < 4)
    {
        CurrentStep++;
        ErrorMessage = string.Empty;
    }
}
```

- [ ] **Step 4: Update CanGoToNextStep to allow navigation from step 3**

Change `CanGoToNextStep()` (line 382-390) from:

```csharp
private bool CanGoToNextStep()
{
    return CurrentStep switch
    {
        1 => IsGmailAuthenticated,
        2 => !string.IsNullOrWhiteSpace(BusinessName) && !string.IsNullOrWhiteSpace(OwnerName),
        _ => false
    };
}
```

To:

```csharp
private bool CanGoToNextStep()
{
    return CurrentStep switch
    {
        1 => IsGmailAuthenticated,
        2 => !string.IsNullOrWhiteSpace(BusinessName) && !string.IsNullOrWhiteSpace(OwnerName),
        3 => !string.IsNullOrWhiteSpace(Password) && Password.Length >= 8 && Password == ConfirmPassword,
        _ => false
    };
}
```

- [ ] **Step 5: Add SaveDeviceModeAsync helper method**

Add this method after the `CanRegister()` method (after line 1708):

```csharp
/// <summary>
/// Saves the device mode selection (multi-caja) after registration completes.
/// Saves locally first, then attempts backend sync (non-blocking).
/// </summary>
private async Task SaveDeviceModeAsync(int tenantId, int branchId, string accessToken)
{
    try
    {
        // 1. Save locally
        var settingsService = App.GetService<ISettingsService>();
        var key = $"MultiCajaEnabled_{tenantId}_{branchId}";
        await settingsService.SaveSettingAsync(key, _multiCajaSelected);
        Debug.WriteLine($"[WelcomeVM] MultiCaja={_multiCajaSelected} guardado localmente ({key})");

        // 2. Sync to backend (non-blocking)
        if (_multiCajaSelected)
        {
            try
            {
                var configuration = App.GetService<Microsoft.Extensions.Configuration.IConfiguration>();
                var baseUrl = configuration?["ApiSettings:BackendUrl"] ?? "https://sya-socketio-server.onrender.com";

                using var httpClient = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(10) };
                httpClient.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

                var payload = new { multi_caja_enabled = true };
                var json = System.Text.Json.JsonSerializer.Serialize(payload);
                var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");

                var response = await httpClient.PutAsync($"/api/branches/{branchId}/settings", content);
                Debug.WriteLine(response.IsSuccessStatusCode
                    ? $"[WelcomeVM] ✅ MultiCaja sincronizado al backend"
                    : $"[WelcomeVM] ⚠️ Error sync multi_caja: {response.StatusCode}");
            }
            catch (Exception syncEx)
            {
                Debug.WriteLine($"[WelcomeVM] ⚠️ No se pudo sincronizar multi_caja (se hará después): {syncEx.Message}");
            }
        }
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"[WelcomeVM] ⚠️ Error guardando modo dispositivo: {ex.Message}");
    }
}
```

- [ ] **Step 6: Hook SaveDeviceModeAsync into the registration flow**

There are two places where registration completes and navigates to LoginPage:

**Place 1 — Overwrite/New Branch mode (line ~1076):**
Before `IsRegistrationComplete = true;` at line 1076, add:

```csharp
// Guardar modo de operación seleccionado
await SaveDeviceModeAsync(realTenantId, realBranchId, _existingAccessToken);
```

**Place 2 — Normal new tenant registration (line ~1680):**
After `await _deviceModeService.SetDeviceModeAsync(DeviceOperationMode.Primary);` at line 1678, add:

```csharp
// Guardar modo de operación seleccionado
// Need to get tenantId/branchId from UserConfig since they were just saved
var savedTenantId = await _userConfigService.GetTenantIdAsync() ?? 0;
var savedBranchId = _userConfigService.GetBranchId() ?? 0;
var savedToken = await _userConfigService.GetJwtTokenAsync();
if (savedTenantId > 0 && savedBranchId > 0 && !string.IsNullOrEmpty(savedToken))
{
    await SaveDeviceModeAsync(savedTenantId, savedBranchId, savedToken);
}
```

- [ ] **Step 7: Verify build compiles**

Run: `dotnet build` (if user approves) or verify no red squiggles in Visual Studio.

- [ ] **Step 8: Commit**

```bash
git add ViewModels/WelcomeViewModel.cs
git commit -m "feat: add Step 4 device mode selection logic to WelcomeViewModel"
```

---

## Task 2: Update stepper UI from 3 to 4 steps

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\WelcomePage.xaml`

- [ ] **Step 1: Update subtitle text**

Change line 55:
```xml
Text="Configura tu cuenta en 3 simples pasos"
```
To:
```xml
Text="Configura tu cuenta en 4 simples pasos"
```

- [ ] **Step 2: Add Step 4 indicator to the stepper Grid**

The stepper Grid (line 61-198) has 5 columns for 3 steps + 2 lines. Change it to 7 columns for 4 steps + 3 lines.

Replace the entire Grid.ColumnDefinitions (lines 62-68):
```xml
<Grid.ColumnDefinitions>
    <ColumnDefinition Width="*" />
    <ColumnDefinition Width="Auto" />
    <ColumnDefinition Width="*" />
    <ColumnDefinition Width="Auto" />
    <ColumnDefinition Width="*" />
    <ColumnDefinition Width="Auto" />
    <ColumnDefinition Width="*" />
</Grid.ColumnDefinitions>
```

After the Step 3 StackPanel (after line 197, before closing `</Grid>`), add:

```xml
<!--  Línea 3  -->
<Border
    Grid.Column="5"
    Width="60"
    Height="2"
    Margin="10,0"
    VerticalAlignment="Center"
    Background="{ThemeResource SystemAccentColor}">
    <Border.Opacity>
        <Binding Mode="OneWay" Path="IsStep4Visible">
            <Binding.Converter>
                <converters:BoolToOpacityConverter FalseValue="0.3" TrueValue="1.0" />
            </Binding.Converter>
        </Binding>
    </Border.Opacity>
</Border>

<!--  Paso 4  -->
<StackPanel
    Grid.Column="6"
    HorizontalAlignment="Center"
    Spacing="6">
    <Border
        Width="40"
        Height="40"
        HorizontalAlignment="Center"
        Background="{ThemeResource SystemAccentColor}"
        CornerRadius="20">
        <Border.Opacity>
            <Binding Mode="OneWay" Path="IsStep4Visible">
                <Binding.Converter>
                    <converters:BoolToOpacityConverter FalseValue="0.3" TrueValue="1.0" />
                </Binding.Converter>
            </Binding>
        </Border.Opacity>
        <TextBlock
            HorizontalAlignment="Center"
            VerticalAlignment="Center"
            FontSize="18"
            FontWeight="Bold"
            Foreground="{ThemeResource PrimaryAccentForegroundBrush}"
            Text="4" />
    </Border>
    <TextBlock
        HorizontalAlignment="Center"
        FontSize="11"
        Foreground="{ThemeResource SecondaryTextBrush}"
        Text="Modo"
        TextAlignment="Center" />
</StackPanel>
```

- [ ] **Step 3: Commit**

```bash
git add Views/WelcomePage.xaml
git commit -m "feat: add Step 4 indicator to onboarding stepper UI"
```

---

## Task 3: Add Step 4 card selection panel

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\WelcomePage.xaml`

- [ ] **Step 1: Add Step 4 panel inside the content Border**

After the Step 3 StackPanel closing tag (after line 443, before `</Grid>` on line 444), add:

```xml
<!--  PASO 4: Modo de operación  -->
<StackPanel Spacing="16" Visibility="{x:Bind ViewModel.IsStep4Visible, Mode=OneWay}">
    <TextBlock
        FontSize="20"
        FontWeight="SemiBold"
        Foreground="{ThemeResource PrimaryTextBrush}"
        Text="¿Cómo usarás tu punto de venta?" />

    <TextBlock
        FontSize="14"
        Foreground="{ThemeResource SecondaryTextBrush}"
        Text="Elige el modo que mejor se adapte a tu negocio."
        TextWrapping="Wrap" />

    <Grid ColumnSpacing="12">
        <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="*" />
        </Grid.ColumnDefinitions>

        <!--  Tarjeta: Un solo dispositivo  -->
        <Border
            x:Name="SingleDeviceCard"
            Grid.Column="0"
            Padding="16"
            Background="{ThemeResource CardBackgroundFillColorDefaultBrush}"
            BorderBrush="{ThemeResource SystemAccentColor}"
            BorderThickness="2"
            CornerRadius="8"
            PointerPressed="SingleDeviceCard_PointerPressed">
            <StackPanel Spacing="10">
                <FontIcon FontSize="32" Glyph="&#xE7F8;" Foreground="{ThemeResource SystemAccentColor}" />
                <TextBlock FontSize="16" FontWeight="Bold" Text="Un solo dispositivo" />
                <TextBlock FontSize="12" Foreground="{ThemeResource SecondaryTextBrush}"
                    Text="Cobra desde una sola computadora. Funciona sin internet." TextWrapping="Wrap" />
                <StackPanel Spacing="4" Margin="0,4,0,0">
                    <TextBlock FontSize="12" Text="&#x2713; Funciona 100% sin conexión" />
                    <TextBlock FontSize="12" Text="&#x2713; Ideal para un punto de cobro" />
                    <TextBlock FontSize="12" Text="&#x2713; Datos guardados localmente" />
                </StackPanel>
                <Border Padding="8" Background="#33F59E0B" CornerRadius="4" Margin="0,4,0,0">
                    <TextBlock FontSize="11" Foreground="#F59E0B"
                        Text="&#x26A0; Solo puedes cobrar en un dispositivo a la vez" TextWrapping="Wrap" />
                </Border>
            </StackPanel>
        </Border>

        <!--  Tarjeta: Multi-caja  -->
        <Border
            x:Name="MultiCajaCard"
            Grid.Column="1"
            Padding="16"
            Background="{ThemeResource CardBackgroundFillColorDefaultBrush}"
            BorderBrush="{ThemeResource ControlStrokeColorDefaultBrush}"
            BorderThickness="1"
            CornerRadius="8"
            PointerPressed="MultiCajaCard_PointerPressed">
            <StackPanel Spacing="10">
                <Grid>
                    <FontIcon FontSize="32" Glyph="&#xE8CE;" Foreground="{ThemeResource SecondaryTextBrush}" HorizontalAlignment="Left" />
                    <Border Padding="6,2" Background="#33F59E0B" CornerRadius="4" HorizontalAlignment="Right" VerticalAlignment="Top">
                        <TextBlock FontSize="10" FontWeight="SemiBold" Foreground="#F59E0B" Text="Requiere internet" />
                    </Border>
                </Grid>
                <TextBlock FontSize="16" FontWeight="Bold" Text="Multi-caja" />
                <TextBlock FontSize="12" Foreground="{ThemeResource SecondaryTextBrush}"
                    Text="Cobra desde varios dispositivos al mismo tiempo." TextWrapping="Wrap" />
                <StackPanel Spacing="4" Margin="0,4,0,0">
                    <TextBlock FontSize="12" Text="&#x2713; 2+ cajas cobrando simultáneamente" />
                    <TextBlock FontSize="12" Text="&#x2713; Sincronización en tiempo real" />
                    <TextBlock FontSize="12" Text="&#x2713; Computadora o celular" />
                </StackPanel>
                <Border Padding="8" Background="#33F59E0B" CornerRadius="4" Margin="0,4,0,0">
                    <TextBlock FontSize="11" Foreground="#F59E0B"
                        Text="&#x26A0; Requiere conexión a internet estable" TextWrapping="Wrap" />
                </Border>
            </StackPanel>
        </Border>
    </Grid>

    <!--  Nota de cambio posterior  -->
    <TextBlock
        FontSize="11"
        Foreground="{ThemeResource SecondaryTextBrush}"
        Text="Puedes cambiar esto después en Configuración → Dispositivos. Para desactivar multi-caja, todos los turnos deben estar cerrados."
        TextWrapping="Wrap"
        TextAlignment="Center" />
</StackPanel>
```

- [ ] **Step 2: Change Step 3 button from Register to Next**

Replace the Step 3 button (lines 538-555) from:

```xml
<!--  Botón Finalizar (Paso 3)  -->
<Button
    Grid.Column="1"
    Height="48"
    Margin="6,0,0,0"
    HorizontalAlignment="Stretch"
    Command="{x:Bind ViewModel.RegisterCommand}"
    CornerRadius="8"
    Style="{ThemeResource AccentButtonStyle}"
    Visibility="{x:Bind ViewModel.IsStep3Visible, Mode=OneWay}">
    <StackPanel Orientation="Horizontal" Spacing="8">
        <FontIcon FontSize="14" Glyph="&#xE73E;" />
        <TextBlock
            FontSize="12"
            FontWeight="SemiBold"
            Text="COMENZAR PRUEBA GRATIS" />
    </StackPanel>
</Button>
```

To:

```xml
<!--  Botón Siguiente (Paso 3)  -->
<Button
    Grid.Column="1"
    Height="48"
    Margin="6,0,0,0"
    HorizontalAlignment="Stretch"
    Command="{x:Bind ViewModel.NextStepCommand}"
    CornerRadius="8"
    Style="{ThemeResource AccentButtonStyle}"
    Visibility="{x:Bind ViewModel.IsStep3Visible, Mode=OneWay}">
    <StackPanel Orientation="Horizontal" Spacing="8">
        <TextBlock
            FontSize="14"
            FontWeight="SemiBold"
            Text="Siguiente" />
        <FontIcon FontSize="14" Glyph="&#xE76C;" />
    </StackPanel>
</Button>

<!--  Botón Finalizar (Paso 4)  -->
<Button
    Grid.Column="1"
    Height="48"
    Margin="6,0,0,0"
    HorizontalAlignment="Stretch"
    Command="{x:Bind ViewModel.RegisterCommand}"
    CornerRadius="8"
    Style="{ThemeResource AccentButtonStyle}"
    Visibility="{x:Bind ViewModel.IsStep4Visible, Mode=OneWay}">
    <StackPanel Orientation="Horizontal" Spacing="8">
        <FontIcon FontSize="14" Glyph="&#xE73E;" />
        <TextBlock
            FontSize="12"
            FontWeight="SemiBold"
            Text="COMENZAR PRUEBA GRATIS" />
    </StackPanel>
</Button>
```

- [ ] **Step 3: Commit**

```bash
git add Views/WelcomePage.xaml
git commit -m "feat: add Step 4 device mode card selection UI"
```

---

## Task 4: Add card selection handlers in code-behind

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\WelcomePage.xaml.cs`

- [ ] **Step 1: Add card click handlers**

Add these methods to `WelcomePage.xaml.cs`:

```csharp
private void SingleDeviceCard_PointerPressed(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
{
    ViewModel.MultiCajaSelected = false;
    UpdateCardSelection();
}

private void MultiCajaCard_PointerPressed(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
{
    // Check internet before allowing multi-caja selection
    if (!System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable())
    {
        // Show warning but still allow selection — internet check happens on register
        // User might get internet before clicking register
    }
    ViewModel.MultiCajaSelected = true;
    UpdateCardSelection();
}

private void UpdateCardSelection()
{
    if (SingleDeviceCard == null || MultiCajaCard == null) return;

    if (ViewModel.MultiCajaSelected)
    {
        // Multi-caja selected
        MultiCajaCard.BorderBrush = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["SystemAccentColor"];
        MultiCajaCard.BorderThickness = new Thickness(2);
        SingleDeviceCard.BorderBrush = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["ControlStrokeColorDefaultBrush"];
        SingleDeviceCard.BorderThickness = new Thickness(1);
    }
    else
    {
        // Single device selected (default)
        SingleDeviceCard.BorderBrush = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["SystemAccentColor"];
        SingleDeviceCard.BorderThickness = new Thickness(2);
        MultiCajaCard.BorderBrush = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["ControlStrokeColorDefaultBrush"];
        MultiCajaCard.BorderThickness = new Thickness(1);
    }
}
```

- [ ] **Step 2: Add internet validation in RegisterAsync**

In `WelcomeViewModel.cs`, at the beginning of `RegisterAsync()` (after line 586 `IsLoading = true;`), add:

```csharp
// Validate internet if multi-caja selected
if (_multiCajaSelected && !System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable())
{
    ErrorMessage = "Se requiere conexión a internet para activar el modo Multi-caja. Verifica tu conexión e intenta de nuevo.";
    IsLoading = false;
    return;
}
```

- [ ] **Step 3: Commit**

```bash
git add Views/WelcomePage.xaml.cs ViewModels/WelcomeViewModel.cs
git commit -m "feat: card selection handlers and internet validation for Step 4"
```

---

## Task 5: Manual testing

- [ ] **Step 1: Launch the app and navigate to WelcomePage**

Delete or rename the local SQLite database to force the welcome flow. Or use a fresh install.

- [ ] **Step 2: Verify the 4-step flow**

1. Step 1: Gmail auth → Next
2. Step 2: Business info → Next
3. Step 3: Password → Next (NOT "COMENZAR PRUEBA GRATIS")
4. Step 4: Device mode cards → "COMENZAR PRUEBA GRATIS"

- [ ] **Step 3: Verify card selection**

1. Single device card starts selected (accent border)
2. Clicking Multi-caja card selects it (accent border moves)
3. Clicking Single device card switches back

- [ ] **Step 4: Verify internet check**

1. Disconnect internet
2. Select Multi-caja
3. Click "COMENZAR PRUEBA GRATIS"
4. Should show error: "Se requiere conexión a internet..."

- [ ] **Step 5: Verify registration completes with mode saved**

1. Connect internet
2. Complete registration with Multi-caja selected
3. Check Debug output for: `[WelcomeVM] MultiCaja=True guardado localmente`
4. After login, go to Settings → Devices → verify toggle is ON

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: onboarding Step 4 - device mode selection (single vs multi-caja)"
```
