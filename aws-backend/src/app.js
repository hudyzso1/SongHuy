const crypto = require("crypto");
const { PayOS } = require("@payos/node");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    ScanCommand,
    GetCommand,
    PutCommand,
    UpdateCommand,
    DeleteCommand,
    TransactWriteCommand
} = require("@aws-sdk/lib-dynamodb");

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const REGION = process.env.AWS_REGION || "ap-southeast-1";

const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE || "CyberNet-Products";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "CyberNet-Orders";
const MACHINES_TABLE = process.env.MACHINES_TABLE || "CyberNet-Machines";
const CHAT_MESSAGES_TABLE = process.env.CHAT_MESSAGES_TABLE || "CyberNet-ChatMessages";
const PRODUCT_IMAGES_BUCKET = process.env.PRODUCT_IMAGES_BUCKET;
const SCREEN_CAPTURE_BUCKET = process.env.SCREEN_CAPTURE_BUCKET || PRODUCT_IMAGES_BUCKET;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const RENTAL_HOURLY_RATE = Number(process.env.RENTAL_HOURLY_RATE || 15000);

const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID || "";
const PAYOS_API_KEY = process.env.PAYOS_API_KEY || "";
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY || "";
const PAYOS_RETURN_URL =
    process.env.PAYOS_RETURN_URL ||
    "https://d2d2g7wks91eyt.cloudfront.net/client.html";
const PAYOS_CANCEL_URL =
    process.env.PAYOS_CANCEL_URL ||
    "https://d2d2g7wks91eyt.cloudfront.net/client.html";

const payOS = PAYOS_CLIENT_ID && PAYOS_API_KEY && PAYOS_CHECKSUM_KEY
    ? new PayOS({
        clientId: PAYOS_CLIENT_ID,
        apiKey: PAYOS_API_KEY,
        checksumKey: PAYOS_CHECKSUM_KEY
    })
    : null;

const dynamoClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: {
        removeUndefinedValues: true
    }
});

const s3 = new S3Client({
    region: REGION,
    requestChecksumCalculation: "WHEN_REQUIRED"
});

function json(statusCode, data) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        },
        body: JSON.stringify(data)
    };
}

function parseBody(event) {
    if (!event.body) return {};

    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;

    try {
        return JSON.parse(rawBody);
    } catch {
        return {};
    }
}

function nowIso() {
    return new Date().toISOString();
}

function makeId() {
    return crypto.randomUUID();
}

function normalizeUsername(username) {
    return String(username || "").trim().toLowerCase();
}

function removePassword(machine) {
    if (!machine) return null;

    const cloned = { ...machine };
    delete cloned.password;
    return cloned;
}

function normalizeProduct(input, existing = {}) {
    const product = {
        ...existing,
        ...input,
        id: existing.id || input.id || makeId(),
        name: input.name || existing.name || "Sản phẩm mới",
        price: Number(input.price ?? existing.price ?? 0),
        stock: Number(input.stock ?? existing.stock ?? 0),
        category: input.category || existing.category || "Khác",
        description: input.description || existing.description || "",
        imageKey: input.imageKey ?? existing.imageKey,
        updatedAt: nowIso()
    };

    if (!product.createdAt) {
        product.createdAt = nowIso();
    }

    return product;
}

async function signProductImage(product) {
    if (!product || !product.imageKey || !PRODUCT_IMAGES_BUCKET) {
        return product;
    }

    const command = new GetObjectCommand({
        Bucket: PRODUCT_IMAGES_BUCKET,
        Key: product.imageKey
    });

    const imageUrl = await getSignedUrl(s3, command, {
        expiresIn: 60 * 15
    });

    return {
        ...product,
        imageUrl
    };
}

async function listProducts() {
    const result = await ddb.send(
        new ScanCommand({
            TableName: PRODUCTS_TABLE
        })
    );

    const items = result.Items || [];
    const signedItems = await Promise.all(items.map(signProductImage));

    signedItems.sort((a, b) => {
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    return signedItems;
}

async function createUploadUrl(body) {
    if (!PRODUCT_IMAGES_BUCKET) {
        throw new Error("PRODUCT_IMAGES_BUCKET is not configured");
    }

    const fileName = body.fileName || body.filename || "product.jpg";
    const contentType = body.contentType || body.mimeType || "image/jpeg";

    const ext = String(fileName).includes(".")
        ? String(fileName).split(".").pop()
        : "jpg";

    const imageKey = `products/${makeId()}.${ext}`;

    const putCommand = new PutObjectCommand({
        Bucket: PRODUCT_IMAGES_BUCKET,
        Key: imageKey,
        ContentType: contentType
    });

    const getCommand = new GetObjectCommand({
        Bucket: PRODUCT_IMAGES_BUCKET,
        Key: imageKey
    });

    const uploadUrl = await getSignedUrl(s3, putCommand, {
        expiresIn: 60 * 10
    });

    const imageUrl = await getSignedUrl(s3, getCommand, {
        expiresIn: 60 * 15
    });

    return {
        success: true,
        uploadUrl,
        imageKey,
        imageUrl,
        method: "PUT",
        expiresIn: 600
    };
}

async function listOrders() {
    const result = await ddb.send(
        new ScanCommand({
            TableName: ORDERS_TABLE
        })
    );

    const items = result.Items || [];

    items.sort((a, b) => {
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    return items;
}

function normalizeOrder(body, existing = {}) {
    const createdAt = existing.createdAt || nowIso();

    return {
        ...existing,
        ...body,
        id: existing.id || body.id || makeId(),
        machineName: body.machineName || existing.machineName || "MAY01",
        items: body.items || existing.items || [],
        itemsSummary: body.itemsSummary || existing.itemsSummary || "",
        totalAmount: Number(body.totalAmount ?? existing.totalAmount ?? 0),
        paymentMethod: body.paymentMethod || existing.paymentMethod || "Cash",
        status: body.status || existing.status || "pending",
        time: body.time || existing.time || new Date().toLocaleTimeString("vi-VN"),
        createdAt,
        updatedAt: nowIso()
    };
}

const DEFAULT_MACHINES = [
    {
        username: "admin",
        password: "admin123",
        role: "admin",
        machineName: "ADMIN",
        displayName: "Quản trị viên",
        status: "online",
        balance: 0,
        remainingSeconds: 0
    },
    {
        username: "may01",
        password: "123456",
        role: "client",
        machineName: "MAY01",
        displayName: "Máy 01",
        status: "idle",
        balance: 0,
        remainingSeconds: 0
    },
    {
        username: "may02",
        password: "123456",
        role: "client",
        machineName: "MAY02",
        displayName: "Máy 02",
        status: "idle",
        balance: 0,
        remainingSeconds: 0
    },
    {
        username: "may03",
        password: "123456",
        role: "client",
        machineName: "MAY03",
        displayName: "Máy 03",
        status: "idle",
        balance: 0,
        remainingSeconds: 0
    }
];

async function seedMachines(force = false) {
    const result = await ddb.send(
        new ScanCommand({
            TableName: MACHINES_TABLE,
            Limit: 1
        })
    );

    if (!force && result.Items && result.Items.length > 0) {
        return {
            seeded: false,
            message: "Machines table already has data"
        };
    }

    const time = nowIso();

    for (const machine of DEFAULT_MACHINES) {
        await ddb.send(
            new PutCommand({
                TableName: MACHINES_TABLE,
                Item: {
                    ...machine,
                    username: normalizeUsername(machine.username),
                    createdAt: time,
                    updatedAt: time
                }
            })
        );
    }

    return {
        seeded: true,
        count: DEFAULT_MACHINES.length
    };
}

async function ensureMachinesSeeded() {
    await seedMachines(false);
}

async function listMachines() {
    await ensureMachinesSeeded();

    const result = await ddb.send(
        new ScanCommand({
            TableName: MACHINES_TABLE
        })
    );

    const items = (result.Items || []).map(removePassword);

    items.sort((a, b) => {
        return String(a.machineName || a.username).localeCompare(String(b.machineName || b.username));
    });

    return items;
}

async function loginMachine(body) {
    await ensureMachinesSeeded();

    const username = normalizeUsername(body.username || body.email);
    const password = String(body.password || "");

    if (!username || !password) {
        return {
            success: false,
            message: "Thiếu username hoặc password"
        };
    }

    const result = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username }
        })
    );

    const machine = result.Item;

    if (!machine || String(machine.password) !== password) {
        return {
            success: false,
            message: "Sai tài khoản hoặc mật khẩu"
        };
    }

    await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: { username },
            UpdateExpression: "SET lastLoginAt = :lastLoginAt, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
                ":lastLoginAt": nowIso(),
                ":updatedAt": nowIso()
            }
        })
    );

    const safeMachine = removePassword(machine);

    return {
        success: true,
        message: "Đăng nhập thành công",
        user: safeMachine,
        machine: safeMachine,
        token: `cybernet-demo-${username}-${Date.now()}`
    };
}

async function registerMachine(body) {
    await ensureMachinesSeeded();

    const username = normalizeUsername(body.username || body.email);
    const password = String(body.password || "");

    if (!username || !password) {
        return {
            success: false,
            message: "Thiếu username hoặc password"
        };
    }

    if (username === "admin") {
        return {
            success: false,
            message: "Không được đăng ký tài khoản admin"
        };
    }

    const existing = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username }
        })
    );

    if (existing.Item) {
        return {
            success: false,
            message: "Tài khoản đã tồn tại"
        };
    }

    const time = nowIso();

    const machine = {
        username,
        password,
        role: "client",
        machineName: username.toUpperCase(),
        displayName: username.toUpperCase(),
        status: "idle",
        balance: 0,
        remainingSeconds: 0,
        createdAt: time,
        updatedAt: time
    };

    await ddb.send(
        new PutCommand({
            TableName: MACHINES_TABLE,
            Item: machine
        })
    );

    return {
        success: true,
        message: "Đăng ký thành công",
        user: removePassword(machine)
    };
}

async function updateMachineStatus(username, body) {
    const normalizedUsername = normalizeUsername(username);

    const status = body.status || "idle";

    const result = await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: { username: normalizedUsername },
            UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
            ExpressionAttributeNames: {
                "#status": "status"
            },
            ExpressionAttributeValues: {
                ":status": status,
                ":updatedAt": nowIso()
            },
            ReturnValues: "ALL_NEW"
        })
    );

    return removePassword(result.Attributes);
}

async function topupMachine(body) {
    const username = normalizeUsername(body.username || body.machineName || body.machine);
    const amount = Number(body.amount || 0);

    if (!username || amount <= 0) {
        return {
            success: false,
            message: "Thiếu máy hoặc số tiền nạp không hợp lệ"
        };
    }

    const addedSeconds = Math.floor(amount / 1000) * 60;

    const result = await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: { username },
            UpdateExpression: "SET updatedAt = :updatedAt ADD balance :amount, remainingSeconds :seconds",
            ExpressionAttributeValues: {
                ":amount": amount,
                ":seconds": addedSeconds,
                ":updatedAt": nowIso()
            },
            ReturnValues: "ALL_NEW"
        })
    );

    return {
        success: true,
        machine: removePassword(result.Attributes)
    };
}
async function listChatMessages() {
    const result = await ddb.send(
        new ScanCommand({
            TableName: CHAT_MESSAGES_TABLE
        })
    );

    const messages = result.Items || [];

    messages.sort((a, b) => {
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });

    return messages.slice(-100);
}

async function createChatMessage(body) {
    const username =
        body.username ||
        body.user ||
        body.sender ||
        body.from ||
        body.machineName ||
        "unknown";

    const message =
        body.message ||
        body.text ||
        body.content ||
        body.msg ||
        body.chat ||
        body.chatMessage ||
        body.messageText ||
        body.value ||
        "";

    if (!String(message).trim()) {
        return {
            success: false,
            message: "Nội dung chat không được rỗng",
            receivedBody: body
        };
    }

    const item = {
        id: makeId(),
        username: String(username),
        sender: String(username),
        from: String(username),
        message: String(message),
        text: String(message),
        content: String(message),
        msg: String(message),
        createdAt: nowIso()
    };

    await ddb.send(
        new PutCommand({
            TableName: CHAT_MESSAGES_TABLE,
            Item: item
        })
    );

    return {
        success: true,
        chat: item,
        message: item
    };
}

function parseImageDataUrl(imageData) {
    const raw = String(imageData || "");

    const match = raw.match(/^data:(.+?);base64,(.+)$/);

    if (match) {
        return {
            contentType: match[1],
            buffer: Buffer.from(match[2], "base64")
        };
    }

    return {
        contentType: "image/jpeg",
        buffer: Buffer.from(raw, "base64")
    };
}

async function uploadClientScreen(body) {
    if (!SCREEN_CAPTURE_BUCKET) {
        throw new Error("SCREEN_CAPTURE_BUCKET is not configured");
    }

    const username = normalizeUsername(
        body.username ||
        body.machineName ||
        body.machine ||
        body.user
    );

    const machineName = String(
        body.machineName ||
        body.machine ||
        username.toUpperCase()
    ).toUpperCase();

    const imageData =
        body.imageData ||
        body.image ||
        body.screenshot ||
        body.screen ||
        body.frame ||
        body.dataUrl;

    if (!username || !imageData) {
        return {
            success: false,
            message: "Thiếu username/machineName hoặc imageData"
        };
    }

    const parsed = parseImageDataUrl(imageData);

    if (!parsed.buffer || parsed.buffer.length <= 0) {
        return {
            success: false,
            message: "Dữ liệu ảnh không hợp lệ"
        };
    }

    const contentType = parsed.contentType || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";

    const screenKey = `screens/${username}/latest.${ext}`;
    const updatedAt = nowIso();

    await s3.send(
        new PutObjectCommand({
            Bucket: SCREEN_CAPTURE_BUCKET,
            Key: screenKey,
            Body: parsed.buffer,
            ContentType: contentType,
            CacheControl: "no-store"
        })
    );

    await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: { username },
            UpdateExpression: "SET machineName = :machineName, latestScreenKey = :screenKey, latestScreenUpdatedAt = :updatedAt, latestScreenContentType = :contentType, lastSeenAt = :updatedAt, #status = :status, updatedAt = :updatedAt",
            ExpressionAttributeNames: {
                "#status": "status"
            },
            ExpressionAttributeValues: {
                ":machineName": machineName,
                ":screenKey": screenKey,
                ":updatedAt": updatedAt,
                ":contentType": contentType,
                ":status": "playing"
            },
            ReturnValues: "ALL_NEW"
        })
    );

    return {
        success: true,
        username,
        machineName,
        screenKey,
        updatedAt
    };
}

async function signScreenUrl(machine) {
    if (!machine || !machine.latestScreenKey || !SCREEN_CAPTURE_BUCKET) {
        return {
            ...removePassword(machine),
            screenUrl: null
        };
    }

    const command = new GetObjectCommand({
        Bucket: SCREEN_CAPTURE_BUCKET,
        Key: machine.latestScreenKey
    });

    const screenUrl = await getSignedUrl(s3, command, {
        expiresIn: 60
    });

    return {
        ...removePassword(machine),
        screenUrl
    };
}

async function listScreenMachines() {
    await ensureMachinesSeeded();

    const result = await ddb.send(
        new ScanCommand({
            TableName: MACHINES_TABLE
        })
    );

    const machines = result.Items || [];
    const signed = await Promise.all(machines.map(signScreenUrl));

    signed.sort((a, b) => {
        return String(a.machineName || a.username).localeCompare(String(b.machineName || b.username));
    });

    return signed;
}

async function getMachineScreen(username) {
    await ensureMachinesSeeded();

    const normalizedUsername = normalizeUsername(username);

    const result = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username: normalizedUsername }
        })
    );

    if (!result.Item) {
        return null;
    }

    return signScreenUrl(result.Item);
}

async function getMachineScreenImage(username) {
    await ensureMachinesSeeded();

    const normalizedUsername = normalizeUsername(username);

    const result = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username: normalizedUsername }
        })
    );

    const machine = result.Item;

    if (!machine || !machine.latestScreenKey || !SCREEN_CAPTURE_BUCKET) {
        return null;
    }

    const object = await s3.send(
        new GetObjectCommand({
            Bucket: SCREEN_CAPTURE_BUCKET,
            Key: machine.latestScreenKey
        })
    );

    const bytes = await object.Body.transformToByteArray();
    const buffer = Buffer.from(bytes);

    return {
        contentType:
            object.ContentType ||
            machine.latestScreenContentType ||
            "image/jpeg",
        body: buffer.toString("base64")
    };
}

function imageResponse(statusCode, payload, contentType) {
    return {
        statusCode,
        headers: {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
            "Content-Type": contentType || "image/jpeg",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
        },
        isBase64Encoded: statusCode === 200,
        body: payload || ""
    };
}

async function stopMachineScreen(username) {
    const normalizedUsername = normalizeUsername(username);
    const updatedAt = nowIso();

    await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: { username: normalizedUsername },
            UpdateExpression: "SET screenEnabled = :enabled, screenStoppedAt = :updatedAt, updatedAt = :updatedAt, lastSeenAt = :updatedAt, #status = :status REMOVE latestScreenKey, latestScreenUpdatedAt, latestScreenContentType",
            ExpressionAttributeNames: {
                "#status": "status"
            },
            ExpressionAttributeValues: {
                ":enabled": false,
                ":updatedAt": updatedAt,
                ":status": "idle"
            }
        })
    );

    return {
        success: true,
        username: normalizedUsername,
        screenEnabled: false,
        message: "Đã tắt màn hình"
    };
}

async function enableMachineScreen(username) {
    const normalizedUsername = normalizeUsername(username);
    const updatedAt = nowIso();

    await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: { username: normalizedUsername },
            UpdateExpression: "SET screenEnabled = :enabled, screenEnabledAt = :updatedAt, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
                ":enabled": true,
                ":updatedAt": updatedAt
            }
        })
    );

    return {
        success: true,
        username: normalizedUsername,
        screenEnabled: true,
        message: "Đã bật lại màn hình"
    };
}

function ensurePayosReady() {
    return !!payOS;
}

function makePayosOrderCode() {
    return Number(String(Date.now()).slice(-12));
}

function normalizeAmount(value) {
    const amount = Number(value || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
        return 0;
    }

    return Math.round(amount);
}

async function createPayosTopup(body) {
    if (!ensurePayosReady()) {
        return {
            success: false,
            message: "PAYOS credentials are not configured"
        };
    }

    const username = normalizeUsername(
        body.username ||
        body.machine ||
        body.machineName ||
        body.user
    );

    const amount = normalizeAmount(body.amount || body.money || body.total);

    if (!username) {
        return {
            success: false,
            message: "Thiếu username/máy cần nạp"
        };
    }

    if (amount < 1000) {
        return {
            success: false,
            message: "Số tiền nạp tối thiểu là 1.000đ"
        };
    }

    const orderCode = makePayosOrderCode();
    const now = nowIso();

    const topupOrder = {
        id: String(orderCode),
        orderCode,
        type: "payos_topup",
        username,
        machineName: username.toUpperCase(),
        amount,
        total: amount,
        status: "pending",
        paymentStatus: "pending",
        paymentProvider: "payos",
        createdAt: now,
        updatedAt: now
    };

    await ddb.send(
        new PutCommand({
            TableName: ORDERS_TABLE,
            Item: topupOrder
        })
    );

    const paymentData = {
        orderCode,
        amount,
        description: `Nap ${username}`.slice(0, 25),
        items: [
            {
                name: `Nap tien ${username}`.slice(0, 50),
                quantity: 1,
                price: amount
            }
        ],
        returnUrl: PAYOS_RETURN_URL,
        cancelUrl: PAYOS_CANCEL_URL
    };

    const paymentLink = await payOS.paymentRequests.create(paymentData);

    return {
        success: true,
        order: topupOrder,
        payment: paymentLink,
        checkoutUrl: paymentLink.checkoutUrl,
        qrCode: paymentLink.qrCode
    };
}

async function handlePayosWebhook(body) {
    if (!ensurePayosReady()) {
        return {
            success: false,
            message: "PAYOS credentials are not configured"
        };
    }

    let webhookData;

    try {
        webhookData = payOS.webhooks.verify(body);
    } catch (err) {
        console.error("PayOS webhook verify failed:", {
            message: err.message,
            code: body.code,
            success: body.success,
            orderCode: body.data && body.data.orderCode,
            amount: body.data && body.data.amount,
            hasSignature: !!body.signature
        });

        return {
            success: false,
            message: "PayOS webhook signature invalid",
            detail: err.message
        };
    }

    const orderCode = Number(webhookData.orderCode);
    const amount = normalizeAmount(webhookData.amount);

    if (!orderCode || !amount) {
        return {
            success: true,
            ignored: true,
            message: "Webhook thiếu orderCode hoặc amount"
        };
    }

    const orderResult = await ddb.send(
        new GetCommand({
            TableName: ORDERS_TABLE,
            Key: {
                id: String(orderCode)
            }
        })
    );

    const order = orderResult.Item;

    if (!order) {
        return {
            success: true,
            ignored: true,
            message: "Không tìm thấy order PayOS"
        };
    }

    if (order.paymentStatus === "paid") {
        return {
            success: true,
            duplicated: true,
            message: "Webhook đã xử lý trước đó"
        };
    }

    const username = normalizeUsername(order.username);
    const secondsToAdd = Math.floor(amount / 1000) * 3600;
    const now = nowIso();
    if (order.type === "payos_food_order") {
        await ddb.send(
            new UpdateCommand({
                TableName: ORDERS_TABLE,
                Key: {
                    id: String(orderCode)
                },
                UpdateExpression: "SET paymentStatus = :paid, status = :pending, paidAt = :now, updatedAt = :now, payosWebhook = :webhook",
                ExpressionAttributeValues: {
                    ":paid": "paid",
                    ":pending": "pending",
                    ":now": now,
                    ":webhook": body
                }
            })
        );

        return {
            success: true,
            username: normalizeUsername(order.username),
            amount,
            orderCode,
            type: "payos_food_order",
            message: "Đơn đồ ăn PayOS đã thanh toán"
        };
    }


    await ddb.send(
        new UpdateCommand({
            TableName: MACHINES_TABLE,
            Key: {
                username
            },
            UpdateExpression: "SET balance = if_not_exists(balance, :zero) + :amount, remainingSeconds = if_not_exists(remainingSeconds, :zero) + :seconds, lastTopupAt = :now, updatedAt = :now, lastSeenAt = :now",
            ExpressionAttributeValues: {
                ":zero": 0,
                ":amount": amount,
                ":seconds": secondsToAdd,
                ":now": now
            }
        })
    );

    await ddb.send(
        new UpdateCommand({
            TableName: ORDERS_TABLE,
            Key: {
                id: String(orderCode)
            },
            UpdateExpression: "SET paymentStatus = :paid, status = :done, paidAt = :now, updatedAt = :now, payosWebhook = :webhook",
            ExpressionAttributeValues: {
                ":paid": "paid",
                ":done": "done",
                ":now": now,
                ":webhook": body
            }
        })
    );

    return {
        success: true,
        username,
        amount,
        secondsToAdd,
        orderCode,
        message: "Đã cộng tiền từ PayOS"
    };
}

function normalizeFoodItems(items) {
    if (!Array.isArray(items)) return [];

    return items.map(item => {
        const name = String(item.name || item.productName || item.title || "Mon an").slice(0, 50);
        const quantity = Math.max(1, Number(item.quantity || item.qty || 1));
        const price = Math.max(0, Math.round(Number(item.price || item.amount || 0)));

        return {
            name,
            quantity,
            price
        };
    }).filter(item => item.price > 0);
}

async function createPayosFoodOrder(body) {
    if (!ensurePayosReady()) {
        return {
            success: false,
            message: "PAYOS credentials are not configured"
        };
    }

    const username = normalizeUsername(
        body.username ||
        body.machine ||
        body.machineName ||
        body.user
    );

    const items = normalizeFoodItems(body.items || body.cartItems || body.cart || []);

    const calculatedTotal = items.reduce((sum, item) => {
        return sum + item.price * item.quantity;
    }, 0);

    const amount = normalizeAmount(body.amount || body.total || calculatedTotal);

    if (!username) {
        return {
            success: false,
            message: "Thiếu username/máy đặt món"
        };
    }

    if (!items.length || amount < 1000) {
        return {
            success: false,
            message: "Giỏ hàng trống hoặc tổng tiền không hợp lệ"
        };
    }

    const orderCode = makePayosOrderCode();
    const now = nowIso();

    const order = {
        id: String(orderCode),
        orderCode,
        type: "payos_food_order",
        username,
        machineName: username.toUpperCase(),
        items,
        cartItems: items,
        amount,
        total: amount,
        status: "pending",
        paymentStatus: "pending",
        paymentProvider: "payos",
        createdAt: now,
        updatedAt: now
    };

    await ddb.send(
        new PutCommand({
            TableName: ORDERS_TABLE,
            Item: order
        })
    );

    const paymentData = {
        orderCode,
        amount,
        description: `Do an ${username}`.slice(0, 25),
        items,
        returnUrl: PAYOS_RETURN_URL,
        cancelUrl: PAYOS_CANCEL_URL
    };

    const paymentLink = await payOS.paymentRequests.create(paymentData);

    return {
        success: true,
        order,
        payment: paymentLink,
        checkoutUrl: paymentLink.checkoutUrl,
        qrCode: paymentLink.qrCode
    };
}

async function getPayosPaymentInfo(orderCode) {
    if (!PAYOS_CLIENT_ID || !PAYOS_API_KEY) {
        return {
            success: false,
            message: "Thiếu PAYOS_CLIENT_ID hoặc PAYOS_API_KEY"
        };
    }

    const res = await fetch(
        `https://api-merchant.payos.vn/v2/payment-requests/${encodeURIComponent(orderCode)}`,
        {
            method: "GET",
            headers: {
                "x-client-id": PAYOS_CLIENT_ID,
                "x-api-key": PAYOS_API_KEY
            }
        }
    );

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.code !== "00") {
        return {
            success: false,
            message: data.desc || "Không lấy được trạng thái PayOS",
            raw: data
        };
    }

    return {
        success: true,
        data: data.data,
        raw: data
    };
}

async function applyPaidPayosOrder(orderCode, options = {}) {
    const key = String(orderCode);
    const now = nowIso();

    const orderResult = await ddb.send(
        new GetCommand({
            TableName: ORDERS_TABLE,
            Key: {
                id: key
            }
        })
    );

    const order = orderResult.Item;

    if (!order) {
        return {
            success: false,
            message: "Không tìm thấy đơn PayOS trong CyberNet-Orders",
            orderCode: key
        };
    }

    if (order.paymentStatus === "paid") {
        return {
            success: true,
            alreadyPaid: true,
            message: "Đơn này đã được cộng tiền trước đó",
            order
        };
    }

    const username = normalizeUsername(order.username);
    const amount = normalizeAmount(
        options.amount ||
        order.amount ||
        order.total ||
        0
    );

    if (!username) {
        return {
            success: false,
            message: "Đơn PayOS thiếu username",
            order
        };
    }

    if (!amount || amount < 1000) {
        return {
            success: false,
            message: "Số tiền PayOS không hợp lệ",
            order
        };
    }

    if (order.type === "payos_food_order") {
        await ddb.send(
            new UpdateCommand({
                TableName: ORDERS_TABLE,
                Key: {
                    id: key
                },
                ConditionExpression: "attribute_not_exists(paymentStatus) OR paymentStatus <> :paid",
                UpdateExpression: "SET paymentStatus = :paid, #s = :pending, paidAt = :now, updatedAt = :now, payosPaidSource = :source, payosPaidRaw = :raw",
                ExpressionAttributeNames: {
                    "#s": "status"
                },
                ExpressionAttributeValues: {
                    ":paid": "paid",
                    ":pending": "pending",
                    ":now": now,
                    ":source": options.source || "unknown",
                    ":raw": options.raw || {}
                }
            })
        );

        return {
            success: true,
            type: "payos_food_order",
            message: "Đơn đồ ăn đã thanh toán PayOS",
            orderCode: key,
            amount
        };
    }

    if (order.type !== "payos_topup") {
        return {
            success: false,
            message: "Loại đơn PayOS không hỗ trợ cộng tiền máy",
            type: order.type,
            order
        };
    }

    // Theo số hiện tại của m: 20.000đ = 1200 giây => 1.000đ = 60 giây
    const secondsToAdd = Math.floor(amount / 1000) * 60;

    try {
        await ddb.send(
            new TransactWriteCommand({
                TransactItems: [
                    {
                        Update: {
                            TableName: ORDERS_TABLE,
                            Key: {
                                id: key
                            },
                            ConditionExpression: "attribute_not_exists(paymentStatus) OR paymentStatus <> :paid",
                            UpdateExpression: "SET paymentStatus = :paid, #s = :done, paidAt = :now, updatedAt = :now, payosPaidSource = :source, payosPaidRaw = :raw",
                            ExpressionAttributeNames: {
                                "#s": "status"
                            },
                            ExpressionAttributeValues: {
                                ":paid": "paid",
                                ":done": "done",
                                ":now": now,
                                ":source": options.source || "unknown",
                                ":raw": options.raw || {}
                            }
                        }
                    },
                    {
                        Update: {
                            TableName: MACHINES_TABLE,
                            Key: {
                                username
                            },
                            UpdateExpression: "SET updatedAt = :now, lastTopupAt = :now ADD balance :amount, remainingSeconds :seconds",
                            ExpressionAttributeValues: {
                                ":now": now,
                                ":amount": amount,
                                ":seconds": secondsToAdd
                            }
                        }
                    }
                ]
            })
        );
    } catch (err) {
        if (
            err.name === "TransactionCanceledException" ||
            err.name === "ConditionalCheckFailedException"
        ) {
            return {
                success: true,
                alreadyPaid: true,
                message: "Đơn đã xử lý trước đó, không cộng trùng",
                orderCode: key
            };
        }

        throw err;
    }

    return {
        success: true,
        type: "payos_topup",
        message: "Đã cộng tiền PayOS vào tài khoản khách",
        username,
        orderCode: key,
        amount,
        secondsToAdd
    };
}

async function syncPayosOrder(body) {
    const orderCode =
        body.orderCode ||
        body.id ||
        body.paymentLinkId;

    if (!orderCode) {
        return {
            success: false,
            message: "Thiếu orderCode để sync PayOS"
        };
    }

    const info = await getPayosPaymentInfo(orderCode);

    if (!info.success) {
        return info;
    }

    const payosData = info.data || {};
    const status = String(payosData.status || "").toUpperCase();

    if (status !== "PAID") {
        return {
            success: false,
            paid: false,
            message: "Đơn PayOS chưa ở trạng thái PAID",
            status,
            payosData
        };
    }

    const amount =
        normalizeAmount(payosData.amountPaid) ||
        normalizeAmount(payosData.amount) ||
        0;

    return await applyPaidPayosOrder(orderCode, {
        amount,
        source: "sync",
        raw: info.raw
    });
}

async function handlePayosWebhookV2(body) {
    let webhookData;

    try {
        webhookData = payOS.webhooks.verify(body);
    } catch (err) {
        console.error("PayOS webhook verify failed:", {
            message: err.message,
            orderCode: body.data && body.data.orderCode,
            amount: body.data && body.data.amount,
            code: body.data && body.data.code,
            desc: body.data && body.data.desc,
            hasSignature: !!body.signature
        });

        return {
            success: false,
            message: "PayOS webhook signature invalid",
            detail: err.message
        };
    }

    const orderCode = Number(webhookData.orderCode);
    const amount = normalizeAmount(webhookData.amount);
    const code = String(webhookData.code || "");

    if (code && code !== "00") {
        return {
            success: true,
            ignored: true,
            message: "Webhook PayOS không phải giao dịch thành công",
            code,
            orderCode
        };
    }

    return await applyPaidPayosOrder(orderCode, {
        amount,
        source: "webhook",
        raw: body
    });
}

function toMoneyNumber(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}

function secondsFromBalance(balance, hourlyRate) {
    const money = toMoneyNumber(balance);
    const rate = Number(hourlyRate || RENTAL_HOURLY_RATE || 15000);

    if (money <= 0 || rate <= 0) return 0;

    return Math.floor((money * 3600) / rate);
}

function formatTimerSeconds(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds || 0)));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

async function settleRentalTimer(username, mode = "tick") {
    username = normalizeUsername(username);

    if (!username) {
        return {
            success: false,
            message: "Thiếu username"
        };
    }

    const now = new Date();
    const nowText = now.toISOString();

    const result = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username }
        })
    );

    const machine = result.Item;

    if (!machine) {
        return {
            success: false,
            message: "Không tìm thấy máy khách",
            username
        };
    }

    const hourlyRate = Number(machine.hourlyRate || RENTAL_HOURLY_RATE || 15000);
    let balance = toMoneyNumber(machine.balance);
    let rentalActive = machine.rentalActive === true || machine.timerActive === true;

    if (mode === "start" && balance > 0) {
        rentalActive = true;
    }

    if (mode === "stop") {
        rentalActive = false;
    }

    let elapsedSeconds = 0;
    let chargedAmount = 0;

    const lastSyncText =
        machine.rentalLastSyncedAt ||
        machine.timerLastSyncedAt ||
        machine.rentalStartedAt ||
        machine.startedAt ||
        nowText;

    if (rentalActive && lastSyncText) {
        const last = new Date(lastSyncText);

        if (!Number.isNaN(last.getTime())) {
            elapsedSeconds = Math.max(0, Math.floor((now.getTime() - last.getTime()) / 1000));
        }

        if (elapsedSeconds > 0) {
            chargedAmount = Math.ceil((elapsedSeconds * hourlyRate) / 3600);
            balance = Math.max(0, balance - chargedAmount);
        }
    }

    const remainingSeconds = secondsFromBalance(balance, hourlyRate);
    const expired = remainingSeconds <= 0;

    if (expired) {
        rentalActive = false;
        balance = 0;
    }

    const updateNames = {};

    const updateValues = {
        ":balance": balance,
        ":remainingSeconds": remainingSeconds,
        ":hourlyRate": hourlyRate,
        ":rentalActive": rentalActive,
        ":now": nowText,
        ":lastChargedAmount": chargedAmount,
        ":lastElapsedSeconds": elapsedSeconds,
        ":expired": expired
    };

    let updateExpression =
        "SET balance = :balance, remainingSeconds = :remainingSeconds, hourlyRate = :hourlyRate, rentalActive = :rentalActive, timerActive = :rentalActive, rentalLastSyncedAt = :now, updatedAt = :now, lastChargedAmount = :lastChargedAmount, lastElapsedSeconds = :lastElapsedSeconds, rentalExpired = :expired";

    if (mode === "start" && !machine.rentalStartedAt && !expired) {
        updateExpression += ", rentalStartedAt = :now";
    }

    if (expired) {
        updateNames["#status"] = "status";
        updateExpression += ", #status = :expiredStatus, expiredAt = :now";
        updateValues[":expiredStatus"] = "expired";
    }

    if (mode === "stop") {
        updateExpression += ", rentalStoppedAt = :now";
    }

    const updateParams = {
        TableName: MACHINES_TABLE,
        Key: { username },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: updateValues
    };

    if (Object.keys(updateNames).length > 0) {
        updateParams.ExpressionAttributeNames = updateNames;
    }

    await ddb.send(new UpdateCommand(updateParams));

    return {
        success: true,
        username,
        balance,
        hourlyRate,
        remainingSeconds,
        remainingText: formatTimerSeconds(remainingSeconds),
        rentalActive,
        expired,
        chargedAmount,
        elapsedSeconds,
        message: expired
            ? "Hết tiền, bắt buộc đăng xuất"
            : "Timer thuê máy đã đồng bộ"
    };
}
exports.handler = async (event) => {
    try {
        const method =
            event.requestContext?.http?.method ||
            event.httpMethod ||
            "GET";

        const path = (event.rawPath || event.path || "/").replace(/\/+$/, "") || "/";

        if (method === "OPTIONS") {
            return json(200, { ok: true });
        }

        if (path === "/" || path === "/api/health") {
            return json(200, {
                success: true,
                service: "CyberNet Cloud API",
                region: REGION,
                productsTable: PRODUCTS_TABLE,
                ordersTable: ORDERS_TABLE,
                machinesTable: MACHINES_TABLE,
                chatMessagesTable: CHAT_MESSAGES_TABLE,
                productImagesBucket: PRODUCT_IMAGES_BUCKET || null
            });
        }

        const body = parseBody(event);

        // =========================
        // Product image upload URL
        // =========================
        if (
            method === "POST" &&
            (
                path === "/api/products/upload-url" ||
                path === "/api/products/presigned-url" ||
                path === "/api/product-images/upload-url" ||
                path === "/api/images/upload-url"
            )
        ) {
            const result = await createUploadUrl(body);
            return json(200, result);
        }

        // =========================
        // Products API
        // =========================
        if (path === "/api/products" && method === "GET") {
            const products = await listProducts();
            return json(200, {
                success: true,
                products,
                items: products
            });
        }

        if (path === "/api/products" && method === "POST") {
            const product = normalizeProduct(body);

            await ddb.send(
                new PutCommand({
                    TableName: PRODUCTS_TABLE,
                    Item: product
                })
            );

            const signedProduct = await signProductImage(product);

            return json(201, {
                success: true,
                product: signedProduct
            });
        }

        const productMatch = path.match(/^\/api\/products\/([^/]+)$/);

        if (productMatch) {
            const id = decodeURIComponent(productMatch[1]);

            if (method === "GET") {
                const result = await ddb.send(
                    new GetCommand({
                        TableName: PRODUCTS_TABLE,
                        Key: { id }
                    })
                );

                if (!result.Item) {
                    return json(404, {
                        success: false,
                        message: "Product not found"
                    });
                }

                const product = await signProductImage(result.Item);

                return json(200, {
                    success: true,
                    product
                });
            }

            if (method === "PUT" || method === "PATCH") {
                const existing = await ddb.send(
                    new GetCommand({
                        TableName: PRODUCTS_TABLE,
                        Key: { id }
                    })
                );

                const product = normalizeProduct(
                    {
                        ...body,
                        id
                    },
                    existing.Item || { id }
                );

                await ddb.send(
                    new PutCommand({
                        TableName: PRODUCTS_TABLE,
                        Item: product
                    })
                );

                const signedProduct = await signProductImage(product);

                return json(200, {
                    success: true,
                    product: signedProduct
                });
            }

            if (method === "DELETE") {
                await ddb.send(
                    new DeleteCommand({
                        TableName: PRODUCTS_TABLE,
                        Key: { id }
                    })
                );

                return json(200, {
                    success: true,
                    deletedId: id
                });
            }
        }

        // =========================
        // Orders API
        // =========================
        if (path === "/api/orders" && method === "GET") {
            const orders = await listOrders();

            return json(200, {
                success: true,
                orders,
                items: orders
            });
        }

        if (path === "/api/orders" && method === "POST") {
            const order = normalizeOrder(body);

            await ddb.send(
                new PutCommand({
                    TableName: ORDERS_TABLE,
                    Item: order
                })
            );

            return json(201, {
                success: true,
                order
            });
        }

        const orderStatusMatch = path.match(/^\/api\/orders\/([^/]+)\/status$/);

        if (orderStatusMatch && (method === "PUT" || method === "PATCH")) {
            const id = decodeURIComponent(orderStatusMatch[1]);
            const status = body.status || "completed";

            const result = await ddb.send(
                new UpdateCommand({
                    TableName: ORDERS_TABLE,
                    Key: { id },
                    UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
                    ExpressionAttributeNames: {
                        "#status": "status"
                    },
                    ExpressionAttributeValues: {
                        ":status": status,
                        ":updatedAt": nowIso()
                    },
                    ReturnValues: "ALL_NEW"
                })
            );

            return json(200, {
                success: true,
                order: result.Attributes
            });
        }

        const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);

        if (orderMatch) {
            const id = decodeURIComponent(orderMatch[1]);

            if (method === "GET") {
                const result = await ddb.send(
                    new GetCommand({
                        TableName: ORDERS_TABLE,
                        Key: { id }
                    })
                );

                if (!result.Item) {
                    return json(404, {
                        success: false,
                        message: "Order not found"
                    });
                }

                return json(200, {
                    success: true,
                    order: result.Item
                });
            }

            if (method === "PUT" || method === "PATCH") {
                const existing = await ddb.send(
                    new GetCommand({
                        TableName: ORDERS_TABLE,
                        Key: { id }
                    })
                );

                const order = normalizeOrder(
                    {
                        ...body,
                        id
                    },
                    existing.Item || { id }
                );

                await ddb.send(
                    new PutCommand({
                        TableName: ORDERS_TABLE,
                        Item: order
                    })
                );

                return json(200, {
                    success: true,
                    order
                });
            }

            if (method === "DELETE") {
                await ddb.send(
                    new DeleteCommand({
                        TableName: ORDERS_TABLE,
                        Key: { id }
                    })
                );

                return json(200, {
                    success: true,
                    deletedId: id
                });
            }
        }
        // =========================
// Chat API
// =========================
if (path === "/api/chat" && method === "GET") {
    const messages = await listChatMessages();

    return json(200, {
        success: true,
        messages,
        chats: messages,
        items: messages
    });
}

if (path === "/api/chat" && method === "POST") {
    const result = await createChatMessage(body);

    return json(result.success ? 201 : 400, result);
}

        // =========================
        // Rental Timer API
        // 15.000đ = 1 giờ
        // =========================
        const rentalTimerMatch = path.match(/^\/api\/machines\/([^/]+)\/rental-timer$/);
        const rentalStartMatch = path.match(/^\/api\/machines\/([^/]+)\/start-rental$/);
        const rentalStopMatch = path.match(/^\/api\/machines\/([^/]+)\/stop-rental$/);

        if (rentalTimerMatch && method === "GET") {
            const result = await settleRentalTimer(decodeURIComponent(rentalTimerMatch[1]), "tick");
            return json(result.success ? 200 : 404, result);
        }

        if (rentalStartMatch && method === "POST") {
            const result = await settleRentalTimer(decodeURIComponent(rentalStartMatch[1]), "start");
            return json(result.success ? 200 : 404, result);
        }

        if (rentalStopMatch && method === "POST") {
            const result = await settleRentalTimer(decodeURIComponent(rentalStopMatch[1]), "stop");
            return json(result.success ? 200 : 404, result);
        }
        // =========================
        // Machines / Auth API
        // =========================
        if (path === "/api/machines/seed" && method === "POST") {
            const result = await seedMachines(Boolean(body.force));

            return json(200, {
                success: true,
                ...result
            });
        }

        if (path === "/api/machines" && method === "GET") {
    const machines = await listMachines();

    return json(200, {
        success: true,
        machines,
        items: machines
    });
}

const machineMatch = path.match(/^\/api\/machines\/([^/]+)$/);

if (machineMatch && method === "GET") {
    await ensureMachinesSeeded();

    const username = normalizeUsername(decodeURIComponent(machineMatch[1]));

    const result = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username }
        })
    );

    if (!result.Item) {
        return json(404, {
            success: false,
            message: "Machine not found"
        });
    }

    return json(200, {
        success: true,
        machine: removePassword(result.Item)
    });
}
const machineDetailMatch = path.match(/^\/api\/machines\/([^/]+)$/);

if (machineDetailMatch && method === "GET") {
    await ensureMachinesSeeded();

    const username = normalizeUsername(decodeURIComponent(machineDetailMatch[1]));

    const result = await ddb.send(
        new GetCommand({
            TableName: MACHINES_TABLE,
            Key: { username }
        })
    );

    if (!result.Item) {
        return json(404, {
            success: false,
            message: "Machine not found"
        });
    }

    return json(200, {
        success: true,
        machine: removePassword(result.Item)
    });
}
        if (
            (path === "/api/auth/register" || path === "/api/register" || path === "/register") &&
            method === "POST"
        ) {
            const result = await registerMachine(body);

            return json(result.success ? 201 : 400, result);
        }

        if (
            (path === "/api/auth/login" || path === "/api/login" || path === "/login") &&
            method === "POST"
        ) {
            const result = await loginMachine(body);

            return json(result.success ? 200 : 401, result);
        }

        if (path === "/api/machines/topup" && method === "POST") {
            const result = await topupMachine(body);

            return json(result.success ? 200 : 400, result);
        }

        const machineStatusMatch = path.match(/^\/api\/machines\/([^/]+)\/status$/);

        if (machineStatusMatch && (method === "PUT" || method === "PATCH")) {
            const username = decodeURIComponent(machineStatusMatch[1]);
            const machine = await updateMachineStatus(username, body);

            return json(200, {
                success: true,
                machine
            });
        }


        // =========================
        // Screen Monitoring API
        // =========================
        if (
            (
                path === "/api/client-upload-screen" ||
                path === "/api/screens/upload" ||
                path === "/api/screen/upload"
            ) &&
            method === "POST"
        ) {
            const result = await uploadClientScreen(body);

            return json(result.success ? 201 : 400, result);
        }

        if (path === "/api/screens" && method === "GET") {
            const screens = await listScreenMachines();

            return json(200, {
                success: true,
                screens,
                machines: screens,
                items: screens
            });
        }


        const screenImageMatch = path.match(/^\/api\/screens\/([^/]+)\/image$/);

        if (screenImageMatch && method === "GET") {
            const username = decodeURIComponent(screenImageMatch[1]);
            const image = await getMachineScreenImage(username);

            if (!image) {
                return imageResponse(
                    404,
                    Buffer.from("Screen image not found").toString("base64"),
                    "text/plain"
                );
            }

            return imageResponse(200, image.body, image.contentType);
        }
        const screenMatch = path.match(/^\/api\/screens\/([^/]+)$/);

        if (screenMatch && method === "GET") {
            const username = decodeURIComponent(screenMatch[1]);
            const screen = await getMachineScreen(username);

            if (!screen) {
                return json(404, {
                    success: false,
                    message: "Screen not found"
                });
            }

            return json(200, {
                success: true,
                screen,
                machine: screen
            });
        }

        const screenStopMatch = path.match(/^\/api\/screens\/([^/]+)\/stop$/);

        if (screenStopMatch && ["POST", "PUT", "PATCH"].includes(method)) {
            const username = decodeURIComponent(screenStopMatch[1]);
            const result = await stopMachineScreen(username);

            return json(200, result);
        }

        const screenEnableMatch = path.match(/^\/api\/screens\/([^/]+)\/enable$/);

        if (screenEnableMatch && ["POST", "PUT", "PATCH"].includes(method)) {
            const username = decodeURIComponent(screenEnableMatch[1]);
            const result = await enableMachineScreen(username);

            return json(200, result);
        }

        
        // =========================
        // PayOS API
        // =========================

        if (
            (
                path === "/api/payos/sync" ||
                path === "/api/payos/check"
            ) &&
            method === "POST"
        ) {
            const result = await syncPayosOrder(body);
            return json(result.success ? 200 : 400, result);
        }

        if (
            (
                path === "/api/payos/webhook" ||
                path === "/api/webhooks/payos"
            ) &&
            method === "POST"
        ) {
            const result = await handlePayosWebhookV2(body);
            return json(result.success ? 200 : 400, result);
        }

        if (
            (
                path === "/api/payos/food-order" ||
                path === "/api/orders/payos-food"
            ) &&
            method === "POST"
        ) {
            const result = await createPayosFoodOrder(body);

            return json(result.success ? 201 : 400, result);
        }

        if (
            (
                path === "/api/payos/create-payment" ||
                path === "/api/payos/topup" ||
                path === "/api/topup/payos"
            ) &&
            method === "POST"
        ) {
            const result = await createPayosTopup(body);

            return json(result.success ? 201 : 400, result);
        }

        if (
            (
                path === "/api/payos/webhook" ||
                path === "/api/webhooks/payos"
            ) &&
            method === "POST"
        ) {
            const result = await handlePayosWebhook(body);

            return json(200, result);
        }
        return json(404, {
            success: false,
            message: "Route not found",
            method,
            path
        });
    } catch (error) {
        console.error("CyberNet API error:", error);

        return json(500, {
            success: false,
            message: error.message || "Internal Server Error"
        });
    }
};
