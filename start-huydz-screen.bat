@echo off
cd /d C:\Users\ASUS\Desktop\CyberNet_Cloud

set CYBERNET_USERNAME=huydz
set CYBERNET_MACHINE=HUYDZ
set CYBERNET_SCREEN_INTERVAL=5000

echo Dang chay Screen Agent cho HUYDZ...
node edge-screen-agent.js

pause
