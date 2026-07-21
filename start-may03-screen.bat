@echo off
cd /d C:\Users\ASUS\Desktop\CyberNet_Cloud

set CYBERNET_USERNAME=may03
set CYBERNET_MACHINE=MAY03
set CYBERNET_SCREEN_INTERVAL=5000

echo Dang chay Screen Agent cho MAY03...
node edge-screen-agent.js

pause
