const { app, BrowserWindow, globalShortcut } = require('electron');

let mainWindow;

function createLockScreen() {
    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        fullscreen: true,       
        alwaysOnTop: true,      
        frame: false,           
        kiosk: true,            
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Ép app Electron load cái file giao diện khóa chạy bằng Live Server của fen
    mainWindow.loadURL('http://127.0.0.1:5500/lockscreen.html'); 

    globalShortcut.register('Alt+Tab', () => { return false; });
    globalShortcut.register('CommandOrControl+Escape', () => { return false; });
}

app.whenReady().then(createLockScreen); 