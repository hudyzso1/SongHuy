// =========================================================================
// --- MODULE KẾT NỐI SERVER NGÂN HÀNG THẬT (CART.JS BẢN HOÀN CHỈNH) ------
// =========================================================================

let cart = {}; // Cấu trúc: { item_id: số_lượng }

// 1. THÊM MÓN VÀO GIỎ HÀNG
window.addToCart = function(itemId) {
    const item = db.menu.find(m => m.id === itemId);
    if (item.stock <= 0) return alert("Món này tạm thời hết hàng trong kho!");
    
    cart[itemId] = (cart[itemId] || 0) + 1;
    renderClientView();
}

// 2. GIẢM SỐ LƯỢNG / XÓA KHỎI GIỎ HÀNG
window.removeFromCart = function(itemId) {
    if (cart[itemId] > 1) {
        cart[itemId]--;
    } else {
        delete cart[itemId];
    }
    renderClientView();
}

// 3. VẼ GIAO DIỆN GIỎ HÀNG VÀ TÍNH TỔNG TIỀN
window.renderCartModule = function() {
    const cartItemsContainer = document.getElementById('cart-items');
    let total = 0;

    if (Object.keys(cart).length === 0) {
        cartItemsContainer.innerHTML = `<p class="text-gray-500 text-center py-8">Giỏ hàng đang trống</p>`;
        document.getElementById('cart-total').innerText = "0đ";
        return;
    }

    cartItemsContainer.innerHTML = Object.keys(cart).map(itemId => {
        const item = db.menu.find(m => m.id === itemId);
        const subtotal = item.price * cart[itemId];
        total += subtotal;
        return `
            <div class="flex justify-between items-center bg-slate-900/50 p-2 rounded-lg border border-gray-800">
                <div class="flex-1 pr-2">
                    <p class="font-bold text-white">${item.name}</p>
                    <p class="text-[10px] text-green-400 font-mono">${item.price.toLocaleString()}đ x ${cart[itemId]}</p>
                </div>
                <div class="flex items-center gap-1">
                    <button onclick="removeFromCart('${itemId}')" class="bg-gray-800 hover:bg-red-950 border border-gray-700 px-1.5 py-0.5 rounded text-red-400 font-bold">-</button>
                    <span class="px-1 text-white font-bold">${cart[itemId]}</span>
                    <button onclick="addToCart('${itemId}')" class="bg-gray-800 hover:bg-cyan-950 border border-gray-700 px-1.5 py-0.5 rounded text-cyan-400 font-bold">+</button>
                </div>
            </div>
        `;
    }).join('');

    document.getElementById('cart-total').innerText = total.toLocaleString() + 'đ';
}

// 4. THANH TOÁN ĐỒ ĂN / NẠP TIỀN QUA SERVER NODE.JS (TIỀN THẬT 100%)
window.checkout = function(method) {
    let total = 0;
    Object.keys(cart).forEach(id => {
        const item = db.menu.find(m => m.id === id);
        total += item.price * cart[id]; 
    });

    if (total === 0) return alert("Giỏ hàng của fen đang trống rỗng!");

    if (method === 'balance') {
        if (db.users[user].balance < total) return alert("Tài khoản máy nét không đủ tiền!");
        db.users[user].balance -= total;
        processOrders("Đã trừ tiền tài khoản");
        alert("Thanh toán thành công bằng tài khoản nét!");
    } else if (method === 'momo') {
        // Gọi cổng thanh toán đồ ăn qua ngân hàng thật
        callServerPaymentAPI(total);
    }
}

// Hàm gọi nút nạp tiền giờ chơi ở Cột 4
window.openDepositMomo = function(amount) {
    callServerPaymentAPI(amount);
}

// 🌐 LOGIC THIẾT THỰC: BẮN DATA LÊN SERVER NODE.JS ĐỂ XIN LINK VIETQR THẬT
function callServerPaymentAPI(amountMoney) {
    alert("🔄 Đang kết nối bảo mật tới Server Node.js và Ngân hàng MB...");

    fetch('http://127.0.0.1:3000/create-payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            amount: amountMoney,
            username: user
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.url) {
            // 🚀 THỰC TẾ: Tự động chuyển hướng khách sang trang thanh toán chuẩn của PayOS chứa mã VietQR MB của Huy!
            window.location.href = data.url;
        } else {
            alert("Lỗi kết nối cổng ngân hàng!");
        }
    })
    .catch(err => {
        console.error(err);
        alert("Fen chưa bật file server.js lên chạy rồi! Mở Terminal gõ: node server.js đi fen.");
    });
}

function processOrders(payMethod) {
    Object.keys(cart).forEach(itemId => {
        const item = db.menu.find(m => m.id === itemId);
        db.orders.push({
            id: Date.now() + Math.random(),
            user: user,
            itemId: itemId,
            itemName: `${item.name} (SL: ${cart[itemId]})`,
            price: item.price * cart[itemId],
            status: "Chờ duyệt",
            payment: payMethod
        });
    });
    cart = {}; 
    localStorage.setItem('cyber_db', JSON.stringify(db));
    renderClientView();
}