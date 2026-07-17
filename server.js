const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

let PayOS;
try {
    PayOS = require('@payos/node');
} catch (e) {
    try {
        PayOS = require('@payos/node/dist/index');
    } catch (err) {
        console.log("⚠️ Cảnh báo: Không tìm thấy thư viện @payos/node trong node_modules.");
    }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '200mb' })); 
app.use(express.urlencoded({ limit: '200mb', extended: true }));
const DB_FILE = path.join('C:\\Users\\ASUS\\Desktop', 'database.json');

let globalClientScreens = {};
let payosOrderCache = {}; 
let globalFoodPayments = {}; 

let payos = null;
if (PayOS) {
    try {
        const PayOSClass = PayOS.PayOS || PayOS;
        payos = new PayOSClass(
            '1627c632-8f93-4288-b6c8-015d5f2cd267', 
            '46c65e6e-37a9-4cdd-9e6f-1a2257e58da5', 
            '2e05b2b26777375fdaf02112bbafdc19028a51d082b569b71d2a234af56b3409'
        );
    } catch (e) {
        console.log("⚠️ Cấu hình PayOS SDK lỗi, chạy chế độ mồi.");
    }
}

function readDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const defaultData = [{ username: "admin", password: "admin", role: "admin", status: "playing", time_remaining: "99:99:99", money: 999999 }];
            fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
            return defaultData;
        }
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Lỗi đọc file database.json:", error);
        return [];
    }
}

function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error("Lỗi ghi file database.json:", error);
    }
}

function addMinutesToTimeString(timeStr, minutesToAdd) {
    if (!timeStr || timeStr.split(':').length !== 3) timeStr = "00:00:00";
    let parts = timeStr.split(':');
    let totalSeconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    totalSeconds += Math.round(minutesToAdd * 60);

    let hrs = Math.floor(totalSeconds / 3600);
    let mins = Math.floor((totalSeconds % 3600) / 60);
    let secs = totalSeconds % 60;

    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ======================== HỆ THỐNG API CHÍNH ========================

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Vui lòng điền đủ tài khoản và mật khẩu!" });

    let users = readDatabase();
    const isExist = users.some(u => u.username === username.toLowerCase().trim());
    if (isExist) return res.status(400).json({ error: "Tài khoản này đã có người dùng!" });

    const newUser = {
        username: username.toLowerCase().trim(),
        password: password,
        role: "client",
        status: "locked", 
        time_remaining: "00:00:00",
        money: 0
    };

    users.push(newUser);
    writeDatabase(users);
    res.json({ success: true, msg: "Đăng ký thành công hội viên mới!" });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    let users = readDatabase();
    
    let adminFound = users.find(u => u.username === "admin");
    if (!adminFound) {
        users.push({ username: "admin", password: "admin", role: "admin", status: "playing", time_remaining: "99:99:99", money: 999999 });
        writeDatabase(users);
        users = readDatabase();
    }

    let userFound = users.find(u => u.username === username.toLowerCase().trim() && u.password === password);
    if (!userFound) return res.status(400).json({ error: "Sai tài khoản hoặc mật khẩu rồi fen!" });

    res.json({
        success: true,
        username: userFound.username,
        role: userFound.role,
        status: userFound.status,
        time_remaining: userFound.time_remaining || "00:00:00",
        money: userFound.money
    });
});

app.get('/api/sync-devices', (req, res) => {
    let users = readDatabase();
    let clients = users.filter(u => u.role !== 'admin');
    res.json(clients);
});

app.post('/api/admin-topup', (req, res) => {
    const { username, amount } = req.body;
    let users = readDatabase();
    let userFound = users.find(u => u.username === username.toLowerCase().trim());

    if (!userFound) return res.status(404).json({ error: "Tài khoản khách không tồn tại!" });

    userFound.money += amount;
    userFound.status = "playing"; 
    const minutesToAdd = (amount / 10000) * 60; 
    userFound.time_remaining = addMinutesToTimeString(userFound.time_remaining, minutesToAdd);

    writeDatabase(users);
    res.json({ success: true, msg: `Đã nạp thành công ${amount.toLocaleString()}đ!` });
});

app.post('/create-payment-link', async (req, res) => {
    const { amount, username, type } = req.body;
    if (!username) return res.status(400).json({ error: "Thiếu tên username!" });
    
    const orderCode = Math.floor(100000 + Math.random() * 900000);          
    payosOrderCache[orderCode] = {
        username: username.toLowerCase().trim(),
        type: type || 'topup' 
    };

    if (payos) {
       try {
            const prefix = type === 'food' ? 'DOAN' : 'NAPNET';
            const paymentData = {
                orderCode: orderCode,
                amount: amount,
                description: `${prefix} ${username.toUpperCase()}`.substring(0, 25), 
                cancelUrl: 'http://127.0.0.1:5500/client.html', 
                returnUrl: 'http://127.0.0.1:5500/client.html'  
            };
            const paymentLinkRes = await payos.createPaymentLink(paymentData);
            return res.json({ url: paymentLinkRes.checkoutUrl, orderCode: orderCode });
        } catch (error)  {
            console.error("Lỗi tạo link PayOS:", error);
        }
    }

    res.json({ fallback: true, orderCode: orderCode });
});

app.post('/momo-webhook', async (req, res) => {
    const webhookData = req.body;
    if (!payos) return res.json({ success: true });
    
    try {
        const verifiedData = payos.verifyPaymentWebhookData(webhookData);
        const orderCodeReceived = verifiedData.orderCode; 
        const amountReceived = verifiedData.amount; 
        
        let cacheData = payosOrderCache[orderCodeReceived];
        if (!cacheData && verifiedData.description) {
            const desc = verifiedData.description.toUpperCase();
            const parts = desc.split(' ');
            if (parts.length >= 2) {
                cacheData = {
                    username: parts[1].toLowerCase().trim(),
                    type: desc.includes('DOAN') ? 'food' : 'topup'
                };
            }
        }
        
        if (cacheData) {
            let users = readDatabase();
            let userFound = users.find(u => u.username === cacheData.username);
            
            if (userFound) {
                if (cacheData.type === 'topup') {
                    userFound.money += amountReceived; 
                    userFound.status = "playing";     
                    const minutesToAdd = (amountReceived / 10000) * 20;
                    userFound.time_remaining = addMinutesToTimeString(userFound.time_remaining, minutesToAdd);
                    console.log(`=> CỘNG GIỜ THÀNH CÔNG CHO [${cacheData.username}]`);
                } else if (cacheData.type === 'food') {
                    globalFoodPayments[cacheData.username] = true; 
                    console.log(`=> XÁC NHẬN TIỀN ĐỒ ĂN CHO [${cacheData.username}] (KHÔNG CỘNG GIỜ)`);
                }
                writeDatabase(users);
            }
            delete payosOrderCache[orderCodeReceived];
        }
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: 'Webhook không hợp lệ' });
    }
});

app.get('/api/check-food-payment/:username', (req, res) => {
    const targetUser = req.params.username.toLowerCase().trim();
    if (globalFoodPayments[targetUser]) {
        delete globalFoodPayments[targetUser]; 
        return res.json({ paid: true });
    }
    res.json({ paid: false });
});

app.post('/api/client-upload-screen', (req, res) => {
    const { username, image } = req.body;
    if (username) globalClientScreens[username.toLowerCase().trim()] = image || "";
    res.json({ success: true });
});

app.get('/api/monitor/may01', (req, res) => {
    const targetMachine = req.query.machine || "may01";
    const machineImage = globalClientScreens[targetMachine.toLowerCase().trim()] || "";
    res.json({ image: machineImage });
});

setInterval(() => {
    let users = readDatabase();
    let hasChanges = false;

    users.forEach(user => {
        if (user.role === 'client' && user.status === 'playing' && user.time_remaining) {
            let parts = user.time_remaining.split(':');
            if (parts.length === 3) {
                let totalSeconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
                if (totalSeconds > 0) {
                    totalSeconds--; 
                    let hrs = Math.floor(totalSeconds / 3600);
                    let mins = Math.floor((totalSeconds % 3600) / 60);
                    let secs = totalSeconds % 60;
                    user.time_remaining = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
                    hasChanges = true;
                } else {
                    user.time_remaining = "00:00:00";
                    user.status = "locked";
                    hasChanges = true;
                }
            }
        }
    });

    if (hasChanges) writeDatabase(users);
}, 1000);
// ======================================================================
// THÊM ĐOẠN NÀY VÀO TRƯỚC DÒNG app.listen() TRONG FILE SERVER.JS CỦA FEN
// ======================================================================

// 1. Khởi tạo Cơ sở dữ liệu tập trung (Lưu trên RAM của Server)
let globalProducts = [
    { id: 1, name: "Mì tôm bế làm bún", price: 15000, stock: 20 },
    { id: 2, name: "Sting dâu lạnh", price: 12000, stock: 15 }
];
let globalOrders = [];
let globalChats = [];
let globalRevenue = 0; // Doanh thu tổng

// API DOANH THU
app.get('/api/revenue', (req, res) => res.json({ revenue: globalRevenue }));
app.post('/api/revenue', (req, res) => {
    globalRevenue += req.body.amount;
    res.json({ success: true, revenue: globalRevenue });
});

// API SẢN PHẨM (MENU)
app.get('/api/products', (req, res) => res.json(globalProducts));
app.post('/api/products', (req, res) => {
    globalProducts.push(req.body);
    res.json({ success: true });
});
app.delete('/api/products/:id', (req, res) => {
    globalProducts = globalProducts.filter(p => p.id != req.params.id);
    res.json({ success: true });
});

// API ĐƠN HÀNG (GIỎ HÀNG)
app.get('/api/orders', (req, res) => res.json(globalOrders));
app.post('/api/orders', (req, res) => {
    globalOrders.push(req.body);
    res.json({ success: true });
});
app.put('/api/orders/:id', (req, res) => {
    let order = globalOrders.find(o => o.id == req.params.id);
    if(order && order.status === 'pending') {
        order.status = 'completed';
        globalRevenue += order.totalAmount; // Duyệt đơn thì tự cộng tiền vào doanh thu
    }
    res.json({ success: true });
});

// API CHAT (HỖ TRỢ)
app.get('/api/chat', (req, res) => res.json(globalChats));
app.post('/api/chat', (req, res) => {
    globalChats.push(req.body);
    res.json({ success: true });
});
app.put('/api/chat/read', (req, res) => {
    const { machine, reader } = req.body;
    globalChats.forEach(c => {
        // Admin đọc tin nhắn của khách
        if (reader === 'admin' && c.from !== 'admin') c.read = true;
        // Khách đọc tin nhắn của Admin gửi cho máy đó
        if (reader === 'client' && c.machine === machine && c.from === 'admin') c.read = true;
    });
    res.json({ success: true });
});
app.listen(3000, () => {
    console.log('Server chạy tại http://127.0.0.1:3000');
});