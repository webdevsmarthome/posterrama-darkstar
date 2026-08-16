/**
 * PM2 Configuration for posterrama.app
 * This file defines how the application should be run and managed by PM2.
 */
const pkg = require('./package.json');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    const envVars = {};

    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const lines = envContent.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('=')) {
                const [key, ...valueParts] = trimmedLine.split('=');
                let value = valueParts.join('=');

                // Remove quotes if present
                if (
                    (value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))
                ) {
                    value = value.slice(1, -1);
                }

                envVars[key.trim()] = value;
            }
        }
    }

    return envVars;
}

module.exports = {
    apps: [
        {
            name: 'posterrama',
            script: 'npm',
            args: 'start',
            version: pkg.version,
            watch: false, // Disabled auto-restart to prevent conflicts during config saves
            ignore_watch: ['node_modules', 'public', 'README.md', 'sessions', '.env', 'logs'],
            env: {
                // Default to production if not set in .env
                NODE_ENV: 'production',
                APP_VERSION: pkg.version,
                // Audit 2026-08-16 (OPS-2): war 8192 MB und damit groesser als der
                // physische RAM (7,63 GB). Ein leckender Prozess haette nie den
                // PM2-Neustart ausgeloest, sondern zuerst den OOM-Killer geweckt --
                // der nach Heuristik den Chromium-Kiosk oder pihole-FTL trifft.
                // Realer Bedarf im Betrieb: ~264 MB.
                NODE_OPTIONS: '--max-old-space-size=1536', // 1,5 GB Heap-Obergrenze
                ...loadEnvFile(), // Load .env (overrides defaults including NODE_ENV)
            },
            // Force environment update on restart
            restart_delay: 1000,
            // Audit 2026-08-16 (OPS-2): muss unter dem physischen RAM liegen,
            // damit PM2 vor dem OOM-Killer eingreift.
            max_memory_restart: '2048M', // Neustart ab 2 GB RSS
        },
    ],
};
