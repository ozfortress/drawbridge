#!/usr/bin/env python3
"""
Test script for health monitoring webhook.
Use this to test your Discord webhook URL before deploying.
"""

import os
import sys
import asyncio
import aiohttp
import json
from datetime import datetime


async def test_webhook(webhook_url):
    """Test the Discord webhook with a sample health alert."""
    
    # Sample health alert payload
    test_embed = {
        "title": "🧪 Health Monitor Test",
        "description": f"This is a test of the health monitoring system at {datetime.now().isoformat()}",
        "color": 0x00FF00,  # Green for test
        "fields": [
            {
                "name": "Test Status",
                "value": "✅ Webhook configuration is working correctly",
                "inline": False
            },
            {
                "name": "Environment",
                "value": os.getenv('ENVIRONMENT', 'unknown'),
                "inline": True
            },
            {
                "name": "Configuration",
                "value": f"Check Interval: {os.getenv('HEALTH_CHECK_INTERVAL', '60')}s\nAlert Cooldown: {os.getenv('HEALTH_ALERT_COOLDOWN', '1800')}s",
                "inline": True
            }
        ],
        "timestamp": datetime.utcnow().isoformat(),
        "footer": {
            "text": "Health Monitor Test - You can delete this message"
        }
    }
    
    webhook_data = {
        "content": "🧪 **Health Monitor Test** - Testing webhook configuration",
        "embeds": [test_embed]
    }
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(webhook_url, json=webhook_data) as response:
                if response.status == 204:
                    print("✅ Webhook test successful! Check your Discord channel for the test message.")
                    return True
                else:
                    print(f"❌ Webhook test failed with status: {response.status}")
                    response_text = await response.text()
                    print(f"Response: {response_text}")
                    return False
                    
    except Exception as e:
        print(f"❌ Webhook test failed with error: {e}")
        return False


def main():
    """Main function to test webhook configuration."""
    from dotenv import load_dotenv
    
    # Load environment variables
    load_dotenv('dev.env')  # or change to 'prod.env' for production
    
    webhook_url = os.getenv('HEALTH_WEBHOOK_URL')
    
    if not webhook_url:
        print("❌ HEALTH_WEBHOOK_URL not found in environment variables")
        print("Please set HEALTH_WEBHOOK_URL in your .env file")
        print("\nExample:")
        print("HEALTH_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN")
        sys.exit(1)
    
    print("🧪 Testing Discord webhook for health monitoring...")
    print(f"Webhook URL: {webhook_url[:50]}...")
    
    # Run the async test
    success = asyncio.run(test_webhook(webhook_url))
    
    if success:
        print("✅ Webhook configuration is working correctly!")
        print("You should see a test message in your Discord channel.")
    else:
        print("❌ Webhook test failed. Please check your webhook URL.")
        print("\nTroubleshooting:")
        print("1. Make sure the webhook URL is correct")
        print("2. Check that the webhook hasn't been deleted")
        print("3. Verify the bot has permission to send messages to that channel")
    
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()