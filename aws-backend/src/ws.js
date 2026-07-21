const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    PutCommand,
    DeleteCommand,
    ScanCommand
} = require("@aws-sdk/lib-dynamodb");

const {
    ApiGatewayManagementApiClient,
    PostToConnectionCommand,
    DeleteConnectionCommand
} = require("@aws-sdk/client-apigatewaymanagementapi");

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || "CyberNet-WsConnections";

const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION })
);

function res(statusCode, body) {
    return {
        statusCode,
        body: JSON.stringify(body || {})
    };
}

function parseBody(event) {
    try {
        return event.body ? JSON.parse(event.body) : {};
    } catch {
        return {};
    }
}

function makeManagementClient(event) {
    const domainName = event.requestContext.domainName;
    const stage = event.requestContext.stage;

    return new ApiGatewayManagementApiClient({
        region: REGION,
        endpoint: `https://${domainName}/${stage}`
    });
}

async function postToConnection(client, connectionId, payload) {
    try {
        await client.send(
            new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(JSON.stringify(payload))
            })
        );

        return true;
    } catch (err) {
        if (err.name === "GoneException" || err.$metadata?.httpStatusCode === 410) {
            await ddb.send(
                new DeleteCommand({
                    TableName: CONNECTIONS_TABLE,
                    Key: { connectionId }
                })
            );
        }

        return false;
    }
}

async function broadcast(event, body) {
    const client = makeManagementClient(event);

    const scan = await ddb.send(
        new ScanCommand({
            TableName: CONNECTIONS_TABLE
        })
    );

    const connections = scan.Items || [];

    const message = {
        type: body.type || "refresh",
        payload: body.payload || {},
        from: body.from || "unknown",
        at: new Date().toISOString()
    };

    let sent = 0;

    await Promise.all(
        connections.map(async (item) => {
            if (!item.connectionId) return;

            const ok = await postToConnection(client, item.connectionId, message);
            if (ok) sent++;
        })
    );

    return {
        success: true,
        sent,
        message
    };
}

exports.handler = async (event) => {
    const routeKey = event.requestContext.routeKey;
    const connectionId = event.requestContext.connectionId;

    if (routeKey === "$connect") {
        const qs = event.queryStringParameters || {};

        await ddb.send(
            new PutCommand({
                TableName: CONNECTIONS_TABLE,
                Item: {
                    connectionId,
                    username: qs.username || "unknown",
                    role: qs.role || "guest",
                    createdAt: new Date().toISOString(),
                    ttl: Math.floor(Date.now() / 1000) + 86400
                }
            })
        );

        return res(200, { success: true });
    }

    if (routeKey === "$disconnect") {
        await ddb.send(
            new DeleteCommand({
                TableName: CONNECTIONS_TABLE,
                Key: { connectionId }
            })
        );

        return res(200, { success: true });
    }

    const body = parseBody(event);

    if (body.action === "ping") {
        await postToConnection(makeManagementClient(event), connectionId, {
            type: "pong",
            at: new Date().toISOString()
        });

        return res(200, { success: true });
    }

    if (body.action === "broadcast" || routeKey === "broadcast") {
        const result = await broadcast(event, body);
        return res(200, result);
    }

    return res(200, {
        success: true,
        routeKey,
        received: body
    });
};
