// Gmail OAuth Methods

const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

module.exports = {
    async startGmailOAuth(req, res) {
        console.log('[Gmail OAuth] Generando URL de autenticación');

        try {
            const redirectUri = process.env.GMAIL_REDIRECT_URI ||
                `${req.protocol}://${req.get('host')}/api/auth/gmail/oauth-callback`;

            const oauth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                redirectUri
            );

            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                prompt: 'consent',
                scope: [
                    'openid',
                    'https://www.googleapis.com/auth/gmail.send',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile'
                ]
            });

            console.log('[Gmail OAuth] ✅ URL generada exitosamente');

            res.json({
                success: true,
                auth_url: authUrl
            });

        } catch (error) {
            console.error('[Gmail OAuth] Error generando URL:', error);
            res.status(500).json({
                success: false,
                message: 'Error al generar URL de autenticación',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    gmailOAuthCallbackPage(req, res) {
        const code = req.query.code;

        if (code) {
            res.send(`
                <html>
                    <head>
                        <title>Autenticación Exitosa</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #4CAF50; }
                        </style>
                    </head>
                    <body>
                        <h1>✅ Autenticación Exitosa</h1>
                        <p>Tu cuenta de Gmail ha sido vinculada correctamente.</p>
                        <p>Puedes cerrar esta ventana.</p>
                    </body>
                </html>
            `);
        } else {
            res.status(400).send(`
                <html>
                    <head>
                        <title>Error de Autenticación</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #f44336; }
                        </style>
                    </head>
                    <body>
                        <h1>❌ Error de Autenticación</h1>
                        <p>No se recibió el código de autorización.</p>
                        <p>Por favor, intenta de nuevo.</p>
                    </body>
                </html>
            `);
        }
    },

    async exchangeGmailCode(req, res) {
        console.log('[Gmail Callback] Intercambiando código por tokens');

        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Código de autorización requerido'
            });
        }

        try {
            const redirectUri = process.env.GMAIL_REDIRECT_URI ||
                `${req.protocol}://${req.get('host')}/api/auth/gmail/oauth-callback`;

            const oauth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                redirectUri
            );

            const { tokens } = await oauth2Client.getToken(code);

            console.log('[Gmail Callback] ✅ Tokens obtenidos exitosamente');
            console.log('[Gmail Callback] 📊 Tokens recibidos de Google:');
            console.log('[Gmail Callback]    - access_token:', tokens.access_token ? 'PRESENTE' : 'NO');
            console.log('[Gmail Callback]    - refresh_token:', tokens.refresh_token ? 'PRESENTE' : '❌ NO PRESENTE');
            console.log('[Gmail Callback]    - id_token:', tokens.id_token ? 'Sí' : 'NO');
            console.log('[Gmail Callback]    - expiry_date:', tokens.expiry_date);

            if (!tokens.refresh_token) {
                console.error('[Gmail Callback] ❌ ERROR CRÍTICO: Google NO devolvió refresh_token!');
                console.error('[Gmail Callback] Esto ocurre cuando el usuario ya autorizó la app antes.');
                console.error('[Gmail Callback] Solución: Asegurar que prompt=consent esté en la URL de auth.');
            }

            res.json({
                success: true,
                tokens: {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    id_token: tokens.id_token,
                    expiry_date: tokens.expiry_date,
                    token_type: tokens.token_type,
                    scope: tokens.scope
                }
            });

        } catch (error) {
            console.error('[Gmail Callback] Error intercambiando código:', error);
            res.status(500).json({
                success: false,
                message: 'Error al intercambiar código de autorización',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    async refreshGmailToken(req, res) {
        console.log('[Gmail Refresh] Refrescando access token');

        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token requerido'
            });
        }

        try {
            const oauth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET
            );

            oauth2Client.setCredentials({
                refresh_token: refresh_token
            });

            const { credentials } = await oauth2Client.refreshAccessToken();

            console.log('[Gmail Refresh] ✅ Access token refrescado exitosamente');

            res.json({
                success: true,
                tokens: {
                    access_token: credentials.access_token,
                    refresh_token: credentials.refresh_token || refresh_token,
                    expiry_date: credentials.expiry_date,
                    token_type: credentials.token_type,
                    scope: credentials.scope
                }
            });

        } catch (error) {
            console.error('[Gmail Refresh] Error refrescando token:', error);
            res.status(401).json({
                success: false,
                message: 'Error al refrescar access token. El refresh token puede ser inválido o expirado.',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    }

};
