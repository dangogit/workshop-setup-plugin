---
name: meta-report
description: Generate a weekly Meta Ads performance report. Pulls data from Meta Marketing API, analyzes campaigns, and provides recommendations. Use when user says "meta report", "weekly report", "campaign analysis", "ads performance".
user-invocable: true
argument-hint: "[account_id or leave empty for default]"
---

# Meta Ads Weekly Report

Generate a comprehensive performance report for Meta ad campaigns.

## What to do

1. Use the Meta Ads MCP tools to pull campaign data:
   - Call `get_ad_accounts` to find the ad account
   - Call `list_campaigns` with the account ID
   - Call `get_campaign_performance` or `get_insights` for each active campaign

2. Analyze the data:
   - Identify top 3 performing campaigns by ROAS
   - Identify underperforming campaigns (high spend, low ROAS)
   - Calculate trends vs previous period if data available
   - Note any campaigns with frequency > 3 (ad fatigue)

3. Generate recommendations:
   - Which campaigns to increase budget
   - Which campaigns to pause or kill
   - Which audiences to test
   - Budget reallocation suggestions

4. Format the report in Hebrew with clear sections:
   - Summary (3 key numbers)
   - Top performers
   - Underperformers
   - Recommendations
   - Next steps

5. If Supabase is connected, save the report data for historical tracking.

## Output format

Clean, readable Hebrew report. Numbers in LTR. Use tables for comparisons.
