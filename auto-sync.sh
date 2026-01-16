#!/bin/bash
cd /root/copychu-scraper
git add .
git commit -m "Auto sync: $(date '+%Y-%m-%d %H:%M')" 2>/dev/null
git push origin main 2>/dev/null
