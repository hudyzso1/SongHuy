"use strict";

const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const serverless = require("serverless-http");

const {
    DynamoDBClient
} = require("@aws-sdk/client-dynamodb");

const {
    DynamoDBDocumentClient,
    ScanCommand,
    PutCommand,
    DeleteCommand,
    UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const {
    getSignedUrl
} = require("@aws-sdk/s3-request-presigner");

const app = express();

app.disable("x-powered-by");

app.use(
    cors({
        origin: process.env.ALLOWED_ORIGIN || "*",
        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

app.use(express.json({ limit: "1mb" }));

const dynamoClient = new DynamoDBClient({});

const dynamo = DynamoDBDocumentClient.from(
    dynamoClient,
    {
        marshallOptions: {
            removeUndefinedValues: true
        }
    }
);

const s3 = new S3Client({
    requestChecksumCalculation: "WHEN_REQUIRED"
});

const PRODUCTS_TABLE =
    process.env.PRODUCTS_TABLE;

const ORDERS_TABLE =
    process.env.ORDERS_TABLE;

const PRODUCT_IMAGES_BUCKET =
    process.env.PRODUCT_IMAGES_BUCKET;

const MAX_IMAGE_SIZE_BYTES =
    5 * 1024 * 1024;

const UPLOAD_URL_EXPIRES_SECONDS =
    300;

const VIEW_URL_EXPIRES_SECONDS =
    3600;

const ALLOWED_IMAGE_TYPES = Object.freeze({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
});

function validateProductsConfig() {
    if (!PRODUCTS_TABLE) {
        throw new Error(
            "Missing PRODUCTS_TABLE environment variable"
        );
    }
}

function validateImagesConfig() {
    if (!PRODUCT_IMAGES_BUCKET) {
        throw new Error(
            "Missing PRODUCT_IMAGES_BUCKET environment variable"
        );
    }
}
function validateOrdersConfig() {
    if (!ORDERS_TABLE) {
        throw new Error(
            "Missing ORDERS_TABLE environment variable"
        );
    }
}

const ORDER_STATUSES = new Set([
    "pending",
    "done",
    "completed",
    "cancelled"
]);

function normalizeOrderStatus(value) {
    const status = String(value || "pending")
        .trim()
        .toLowerCase();

    if (!ORDER_STATUSES.has(status)) {
        throw new Error("ORDER_STATUS_INVALID");
    }

    return status;
}
function normalizeImageKey(value) {
    const imageKey =
        String(value || "").trim();

    if (!imageKey) {
        return "";
    }

    if (
        !imageKey.startsWith("products/") ||
        imageKey.includes("..")
    ) {
        throw new Error("IMAGE_KEY_INVALID");
    }

    return imageKey;
}

async function createViewUrl(imageKey) {
    if (!imageKey) {
        return null;
    }

    const command = new GetObjectCommand({
        Bucket: PRODUCT_IMAGES_BUCKET,
        Key: imageKey
    });

    return getSignedUrl(
        s3,
        command,
        {
            expiresIn:
                VIEW_URL_EXPIRES_SECONDS
        }
    );
}

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        service: "CyberNet API",
        environment:
            process.env.NODE_ENV ||
            "development",
        timestamp:
            new Date().toISOString()
    });
});

/*
|--------------------------------------------------------------------------
| TẠO PRESIGNED URL ĐỂ UPLOAD ẢNH
|--------------------------------------------------------------------------
*/

app.post(
    "/api/products/upload-url",
    async (req, res) => {
        try {
            validateImagesConfig();

            const fileName = String(
                req.body?.fileName || ""
            ).trim();

            const contentType = String(
                req.body?.contentType || ""
            )
                .trim()
                .toLowerCase();

            const fileSize = Number(
                req.body?.fileSize
            );

            const extension =
                ALLOWED_IMAGE_TYPES[
                    contentType
                ];

            if (!fileName) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Thiếu tên file ảnh"
                    });
            }

            if (!extension) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP"
                    });
            }

            if (
                !Number.isFinite(fileSize) ||
                fileSize <= 0 ||
                fileSize >
                    MAX_IMAGE_SIZE_BYTES
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Dung lượng ảnh phải lớn hơn 0 và không vượt quá 5 MB"
                    });
            }

            const imageKey =
                `products/${crypto.randomUUID()}.${extension}`;

            const command =
                new PutObjectCommand({
                    Bucket:
                        PRODUCT_IMAGES_BUCKET,
                    Key: imageKey,
                    ContentType:
                        contentType
                });

            const uploadUrl =
                await getSignedUrl(
                    s3,
                    command,
                    {
                        expiresIn:
                            UPLOAD_URL_EXPIRES_SECONDS
                    }
                );

            return res
                .status(200)
                .json({
                    success: true,
                    uploadUrl,
                    imageKey,
                    expiresIn:
                        UPLOAD_URL_EXPIRES_SECONDS,
                    requiredHeaders: {
                        "Content-Type":
                            contentType
                    }
                });
        } catch (error) {
            console.error(
                "POST /api/products/upload-url failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể tạo đường dẫn upload ảnh"
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| LẤY DANH SÁCH SẢN PHẨM
|--------------------------------------------------------------------------
*/

app.get(
    "/api/products",
    async (req, res) => {
        try {
            validateProductsConfig();
            validateImagesConfig();

            const result =
                await dynamo.send(
                    new ScanCommand({
                        TableName:
                            PRODUCTS_TABLE
                    })
                );

            const sortedProducts = (
                result.Items || []
            ).sort((a, b) =>
                String(
                    a.name || ""
                ).localeCompare(
                    String(
                        b.name || ""
                    ),
                    "vi"
                )
            );

            const products =
                await Promise.all(
                    sortedProducts.map(
                        async product => {
                            let imageUrl =
                                null;

                            if (
                                product.imageKey
                            ) {
                                try {
                                    imageUrl =
                                        await createViewUrl(
                                            product.imageKey
                                        );
                                } catch (
                                    error
                                ) {
                                    console.error(
                                        "Không thể tạo URL ảnh:",
                                        {
                                            productId:
                                                product.id,
                                            imageKey:
                                                product.imageKey,
                                            error
                                        }
                                    );
                                }
                            }

                            return {
                                ...product,
                                imageUrl
                            };
                        }
                    )
                );

            return res
                .status(200)
                .json(products);
        } catch (error) {
            console.error(
                "GET /api/products failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể tải danh sách sản phẩm"
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| THÊM SẢN PHẨM
|--------------------------------------------------------------------------
*/

app.post(
    "/api/products",
    async (req, res) => {
        try {
            validateProductsConfig();

            const name = String(
                req.body?.name || ""
            ).trim();

            const price = Number(
                req.body?.price
            );

            const stock = Number(
                req.body?.stock ?? 0
            );

            let imageKey = "";

            try {
                imageKey =
                    normalizeImageKey(
                        req.body?.imageKey
                    );
            } catch {
                return res
                    .status(400)
                    .json({
                        error:
                            "Mã ảnh sản phẩm không hợp lệ"
                    });
            }

            if (
                !name ||
                !Number.isFinite(price) ||
                price < 0
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Tên hoặc giá sản phẩm không hợp lệ"
                    });
            }

            if (
                !Number.isInteger(stock) ||
                stock < 0
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Số lượng tồn kho phải là số nguyên không âm"
                    });
            }

            const now =
                new Date().toISOString();

            const product = {
                id: crypto.randomUUID(),
                name,
                price,
                stock,
                imageKey:
                    imageKey || undefined,
                createdAt: now,
                updatedAt: now
            };

            await dynamo.send(
                new PutCommand({
                    TableName:
                        PRODUCTS_TABLE,
                    Item: product,
                    ConditionExpression:
                        "attribute_not_exists(id)"
                })
            );

            let imageUrl = null;

            if (imageKey) {
                imageUrl =
                    await createViewUrl(
                        imageKey
                    );
            }

            return res
                .status(201)
                .json({
                    success: true,
                    product: {
                        ...product,
                        imageUrl
                    }
                });
        } catch (error) {
            console.error(
                "POST /api/products failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể thêm sản phẩm"
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| XÓA SẢN PHẨM VÀ ẢNH TRONG S3
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/products/:id",
    async (req, res) => {
        try {
            validateProductsConfig();
            validateImagesConfig();

            const id = String(
                req.params.id || ""
            ).trim();

            if (!id) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Thiếu mã sản phẩm"
                    });
            }

            const result =
                await dynamo.send(
                    new DeleteCommand({
                        TableName:
                            PRODUCTS_TABLE,
                        Key: {
                            id
                        },
                        ReturnValues:
                            "ALL_OLD"
                    })
                );

            if (!result.Attributes) {
                return res
                    .status(404)
                    .json({
                        error:
                            "Không tìm thấy sản phẩm"
                    });
            }

            const imageKey =
                result.Attributes.imageKey;

            if (imageKey) {
                try {
                    await s3.send(
                        new DeleteObjectCommand({
                            Bucket:
                                PRODUCT_IMAGES_BUCKET,
                            Key:
                                imageKey
                        })
                    );
                } catch (error) {
                    console.error(
                        "Đã xóa sản phẩm nhưng không xóa được ảnh:",
                        {
                            id,
                            imageKey,
                            error
                        }
                    );
                }
            }

            return res
                .status(200)
                .json({
                    success: true
                });
        } catch (error) {
            console.error(
                "DELETE /api/products/:id failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể xóa sản phẩm"
                });
        }
    }
);
/*
|--------------------------------------------------------------------------
| ORDERS - LẤY DANH SÁCH ĐƠN HÀNG
|--------------------------------------------------------------------------
*/

app.get(
    "/api/orders",
    async (req, res) => {
        try {
            validateOrdersConfig();

            const result = await dynamo.send(
                new ScanCommand({
                    TableName: ORDERS_TABLE
                })
            );

            const orders = (result.Items || [])
                .sort((a, b) => {
                    return String(
                        b.createdAt || ""
                    ).localeCompare(
                        String(a.createdAt || "")
                    );
                });

            return res
                .status(200)
                .json(orders);
        } catch (error) {
            console.error(
                "GET /api/orders failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể tải danh sách đơn hàng"
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| ORDERS - TẠO ĐƠN HÀNG
|--------------------------------------------------------------------------
*/

app.post(
    "/api/orders",
    async (req, res) => {
        try {
            validateOrdersConfig();

            const id = String(
                req.body?.id || crypto.randomUUID()
            ).trim();

            const machineName = String(
                req.body?.machineName ||
                req.body?.username ||
                ""
            )
                .trim()
                .toLowerCase();

            const itemsSummary = String(
                req.body?.itemsSummary || ""
            ).trim();

            const totalAmount = Number(
                req.body?.totalAmount
            );

            const paymentMethod = String(
                req.body?.paymentMethod || "Unknown"
            ).trim();

            let status = "pending";

            try {
                status = normalizeOrderStatus(
                    req.body?.status || "pending"
                );
            } catch {
                return res
                    .status(400)
                    .json({
                        error:
                            "Trạng thái đơn hàng không hợp lệ"
                    });
            }

            if (!id) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Thiếu mã đơn hàng"
                    });
            }

            if (!machineName) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Thiếu tên máy đặt hàng"
                    });
            }

            if (!itemsSummary) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Thiếu nội dung đơn hàng"
                    });
            }

            if (
                !Number.isFinite(totalAmount) ||
                totalAmount < 0
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Tổng tiền đơn hàng không hợp lệ"
                    });
            }

            const now =
                new Date().toISOString();

            const order = {
                id,
                machineName,
                itemsSummary,
                totalAmount,
                paymentMethod,
                status,
                time:
                    req.body?.time ||
                    new Date().toLocaleTimeString(
                        "vi-VN",
                        {
                            timeZone:
                                "Asia/Ho_Chi_Minh"
                        }
                    ),
                createdAt: now,
                updatedAt: now
            };

            await dynamo.send(
                new PutCommand({
                    TableName: ORDERS_TABLE,
                    Item: order,
                    ConditionExpression:
                        "attribute_not_exists(id)"
                })
            );

            return res
                .status(201)
                .json({
                    success: true,
                    order
                });
        } catch (error) {
            console.error(
                "POST /api/orders failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể tạo đơn hàng"
                });
        }
    }
);

/*
|--------------------------------------------------------------------------
| ORDERS - CẬP NHẬT TRẠNG THÁI ĐƠN HÀNG
|--------------------------------------------------------------------------
*/

async function updateOrderStatusHandler(
    req,
    res
) {
    try {
        validateOrdersConfig();

        const id = String(
            req.params.id || ""
        ).trim();

        let status = "";

        try {
            status = normalizeOrderStatus(
                req.body?.status
            );
        } catch {
            return res
                .status(400)
                .json({
                    error:
                        "Trạng thái đơn hàng không hợp lệ"
                });
        }

        if (!id) {
            return res
                .status(400)
                .json({
                    error:
                        "Thiếu mã đơn hàng"
                });
        }

        const result = await dynamo.send(
            new UpdateCommand({
                TableName: ORDERS_TABLE,
                Key: {
                    id
                },
                UpdateExpression:
                    "SET #status = :status, updatedAt = :updatedAt",
                ConditionExpression:
                    "attribute_exists(id)",
                ExpressionAttributeNames: {
                    "#status": "status"
                },
                ExpressionAttributeValues: {
                    ":status": status,
                    ":updatedAt":
                        new Date().toISOString()
                },
                ReturnValues: "ALL_NEW"
            })
        );

        return res
            .status(200)
            .json({
                success: true,
                order: result.Attributes
            });
    } catch (error) {
        console.error(
            "UPDATE /api/orders/:id/status failed:",
            error
        );

        if (
            error.name ===
            "ConditionalCheckFailedException"
        ) {
            return res
                .status(404)
                .json({
                    error:
                        "Không tìm thấy đơn hàng"
                });
        }

        return res
            .status(500)
            .json({
                error:
                    "Không thể cập nhật đơn hàng"
            });
    }
}

app.patch(
    "/api/orders/:id/status",
    updateOrderStatusHandler
);

app.put(
    "/api/orders/:id/status",
    updateOrderStatusHandler
);

app.put(
    "/api/orders/:id",
    updateOrderStatusHandler
);

/*
|--------------------------------------------------------------------------
| ORDERS - XÓA ĐƠN HÀNG
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/orders/:id",
    async (req, res) => {
        try {
            validateOrdersConfig();

            const id = String(
                req.params.id || ""
            ).trim();

            if (!id) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Thiếu mã đơn hàng"
                    });
            }

            const result = await dynamo.send(
                new DeleteCommand({
                    TableName: ORDERS_TABLE,
                    Key: {
                        id
                    },
                    ReturnValues: "ALL_OLD"
                })
            );

            if (!result.Attributes) {
                return res
                    .status(404)
                    .json({
                        error:
                            "Không tìm thấy đơn hàng"
                    });
            }

            return res
                .status(200)
                .json({
                    success: true,
                    deletedOrder:
                        result.Attributes
                });
        } catch (error) {
            console.error(
                "DELETE /api/orders/:id failed:",
                error
            );

            return res
                .status(500)
                .json({
                    error:
                        "Không thể xóa đơn hàng"
                });
        }
    }
);
/*
|--------------------------------------------------------------------------
| API KHÔNG TỒN TẠI
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
    res.status(404).json({
        error: "API không tồn tại",
        method: req.method,
        path: req.path
    });
});

/*
|--------------------------------------------------------------------------
| XỬ LÝ LỖI CHUNG
|--------------------------------------------------------------------------
*/

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "Unhandled API error:",
            error
        );

        res.status(500).json({
            error: "Lỗi máy chủ"
        });
    }
);

module.exports.handler =
    serverless(app);

/*
|--------------------------------------------------------------------------
| CHẠY LOCAL KHI DÙNG NODE APP.JS
|--------------------------------------------------------------------------
*/

if (require.main === module) {
    const port =
        Number(
            process.env.PORT || 3000
        );

    app.listen(
        port,
        "127.0.0.1",
        () => {
            console.log(
                `CyberNet API local: http://127.0.0.1:${port}`
            );
        }
    );
}