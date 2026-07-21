const crypto = require("crypto");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    ScanCommand,
    GetCommand,
    PutCommand,
    UpdateCommand,
    DeleteCommand
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

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

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
    const username = body.username || body.user || body.sender || "unknown";
    const message = body.message || body.text || body.content || "";

    if (!String(message).trim()) {
        return {
            success: false,
            message: "Nội dung chat không được rỗng"
        };
    }

    const item = {
        id: makeId(),
        username,
        sender: username,
        message,
        text: message,
        content: message,
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