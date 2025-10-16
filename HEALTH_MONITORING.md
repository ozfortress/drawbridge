# Health Monitoring Configuration

The health monitoring system provides automated monitoring of the Discord bot and sends alerts when issues are detected.

## Features

- **Automated Health Checks**: Periodic monitoring of bot status, database connectivity, memory usage, and websocket connection
- **Discord Webhook Alerts**: Sends alerts to Discord when health checks fail
- **Log Attachments**: Includes the last 100 log lines with alerts to help diagnose issues
- **Alert Cooldown**: Prevents spam by limiting alert frequency
- **Recovery Notifications**: Notifies when the bot recovers from health issues
- **Docker Health Checks**: Integrated with Docker for container orchestration

## Configuration

### 1. Environment Variables

Add the following to your `dev.env` and `prod.env` files:

```bash
# Health Monitoring Configuration
HEALTH_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
HEALTH_CHECK_INTERVAL=60              # Check interval in seconds (default: 60)
HEALTH_ALERT_COOLDOWN=1800           # Alert cooldown in seconds (default: 1800 = 30 minutes)  
HEALTH_LOG_LINES=100                 # Number of log lines to include in alerts (default: 100)
HEALTH_MAX_FAILURES=3                # Number of failures before sending alert (default: 3)
```

### 2. Discord Webhook Setup

1. Go to your Discord server settings
2. Navigate to **Integrations** → **Webhooks**
3. Click **Create Webhook**
4. Configure the webhook:
   - **Name**: `Drawbridge Health Monitor` 
   - **Channel**: Choose a channel for health alerts (e.g., `#bot-status` or `#alerts`)
   - **Avatar**: Optional bot avatar
5. Copy the webhook URL
6. Add the URL to your environment file as `HEALTH_WEBHOOK_URL`

### 3. Test Configuration

Run the test script to verify your webhook configuration:

```bash
python test_health_webhook.py
```

This will send a test message to your Discord channel to confirm the webhook is working.

## Health Check Endpoints

### Web API Endpoint

Access the health status via HTTP:

```
GET /api/health
```

**Response** (200 = healthy, 503 = unhealthy):
```json
{
  "status": "healthy",
  "timestamp": "2025-10-16T12:00:00",
  "uptime_seconds": 3600,
  "consecutive_failures": 0,
  "metrics": {
    "bot_ready": true,
    "database_connected": true,
    "websocket_connected": true,
    "memory_usage_mb": 45.2,
    "uptime_seconds": 3600,
    "last_command_time": "2025-10-16T11:59:30"
  }
}
```

### Docker Health Check

The Docker container includes an automated health check that runs every 30 seconds:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python healthcheck.py || exit 1
```

## Monitored Metrics

The health monitoring system tracks:

- **Bot Ready State**: Whether the Discord bot is logged in and ready
- **WebSocket Connection**: Status of the Discord gateway connection
- **Database Connectivity**: Ability to query the database
- **Memory Usage**: Current memory consumption (requires `psutil`)
- **Command Activity**: Timestamp of last command execution
- **Heartbeat**: Regular heartbeat updates from bot events

## Alert Conditions

Alerts are triggered when:

- Bot is not ready or websocket is disconnected
- Database queries fail
- Memory usage exceeds 1GB
- No heartbeat received for 2× the check interval
- Consecutive failures exceed the configured threshold

## Alert Format

Health alerts include:

- **Severity**: Color-coded embed (red for alerts, green for recovery)
- **Issue Details**: List of specific problems detected
- **System Metrics**: Current bot status and resource usage
- **Log Attachment**: Recent log entries to help diagnose issues
- **Developer Ping**: Mentions the developer role for immediate attention

## Customization

### Adjusting Check Frequency

Modify `HEALTH_CHECK_INTERVAL` to change how often health checks run:
- Lower values (30-60s) provide faster detection but use more resources
- Higher values (120-300s) reduce overhead but delay problem detection

### Alert Cooldown

Adjust `HEALTH_ALERT_COOLDOWN` to control alert frequency:
- Shorter cooldowns provide more frequent updates during outages
- Longer cooldowns reduce notification spam but may delay important updates

### Failure Threshold

Set `HEALTH_MAX_FAILURES` to control alert sensitivity:
- Lower values (1-2) trigger alerts quickly but may cause false alarms
- Higher values (3-5) reduce false alarms but delay legitimate alerts

## Troubleshooting

### Webhook Not Working

1. Verify the webhook URL is correct and accessible
2. Check Discord server permissions for the webhook
3. Run `python test_health_webhook.py` to test connectivity
4. Check the logs for webhook-related errors

### False Alerts

1. Increase `HEALTH_MAX_FAILURES` to require more consecutive failures
2. Adjust `HEALTH_CHECK_INTERVAL` if checks are too frequent
3. Review system resources if memory alerts are frequent

### Missing Alerts

1. Check that `HEALTH_WEBHOOK_URL` is configured
2. Verify the webhook channel is accessible
3. Check alert cooldown hasn't suppressed recent alerts
4. Review logs for health monitoring errors

## Integration with Docker Compose

Example `docker-compose.yml` health check configuration:

```yaml
version: '3.8'
services:
  drawbridge:
    build: .
    environment:
      - HEALTH_WEBHOOK_URL=https://discord.com/api/webhooks/...
    healthcheck:
      test: ["CMD", "python", "healthcheck.py"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
```