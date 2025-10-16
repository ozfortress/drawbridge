#!/usr/bin/env python3
"""
Interactive configuration helper for Drawbridge health monitoring.
"""

import os
import sys
import re


def validate_webhook_url(url):
    """Validate Discord webhook URL format."""
    pattern = r'https://discord\.com/api/webhooks/\d+/[A-Za-z0-9_-]+'
    return re.match(pattern, url) is not None


def update_env_file(filename, webhook_url):
    """Update environment file with webhook URL."""
    try:
        # Read existing file
        if os.path.exists(filename):
            with open(filename, 'r') as f:
                lines = f.readlines()
        else:
            lines = []
        
        # Find and update webhook URL line
        webhook_updated = False
        for i, line in enumerate(lines):
            if line.startswith('HEALTH_WEBHOOK_URL='):
                lines[i] = f'HEALTH_WEBHOOK_URL={webhook_url}\n'
                webhook_updated = True
                break
        
        # Add webhook URL if not found
        if not webhook_updated:
            lines.append(f'HEALTH_WEBHOOK_URL={webhook_url}\n')
        
        # Write updated file
        with open(filename, 'w') as f:
            f.writelines(lines)
        
        return True
        
    except Exception as e:
        print(f"Error updating {filename}: {e}")
        return False


def main():
    """Interactive configuration helper."""
    print("🔧 Drawbridge Health Monitoring Configuration Helper")
    print("=" * 50)
    print()
    
    # Check if environment files exist
    env_files = []
    if os.path.exists('dev.env'):
        env_files.append('dev.env')
    if os.path.exists('prod.env'):
        env_files.append('prod.env')
    
    if not env_files:
        print("❌ No environment files found (dev.env or prod.env)")
        print("Please create at least one environment file first.")
        sys.exit(1)
    
    print("Found environment files:", ', '.join(env_files))
    print()
    
    # Get webhook URL from user
    print("📋 Discord Webhook Setup Instructions:")
    print("1. Go to your Discord server settings")
    print("2. Navigate to Integrations → Webhooks")
    print("3. Click 'Create Webhook'")
    print("4. Choose a channel for health alerts (e.g., #bot-status)")
    print("5. Copy the webhook URL")
    print()
    
    webhook_url = input("🔗 Enter your Discord webhook URL: ").strip()
    
    if not webhook_url:
        print("❌ No webhook URL provided.")
        sys.exit(1)
    
    if not validate_webhook_url(webhook_url):
        print("❌ Invalid webhook URL format.")
        print("Expected format: https://discord.com/api/webhooks/ID/TOKEN")
        sys.exit(1)
    
    # Update environment files
    print()
    success_count = 0
    for env_file in env_files:
        if update_env_file(env_file, webhook_url):
            print(f"✅ Updated {env_file}")
            success_count += 1
        else:
            print(f"❌ Failed to update {env_file}")
    
    if success_count > 0:
        print()
        print("✅ Configuration complete!")
        print()
        print("Next steps:")
        print("1. Test your webhook: python test_health_webhook.py")
        print("2. Deploy your bot with health monitoring enabled")
        print("3. Check your Discord channel for health alerts")
        print()
        print("📚 For more information, see HEALTH_MONITORING.md")
    else:
        print("❌ Failed to update any environment files.")
        sys.exit(1)


if __name__ == '__main__':
    main()