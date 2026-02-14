import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);

  const oldStatus = client.status;
  const oldPriority = client.priority;

  // 如果沒給 status，預設維持原本的 status
  if (!status) {
    status = oldStatus;
  }

  // 驗證 status 是否合法
  if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
    return res.status(400).send({
      'message': 'Invalid status provided.',
      'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
    });
  }

  // 如果 priority 有給，驗證它
  if (priority) {
    priority = parseInt(priority, 10);
    const { valid, messageObj } = validatePriority(priority);
    if (!valid) {
      return res.status(400).send(messageObj);
    }
  }

  // 情境：status 沒變，也沒指定新的 priority → 什麼都不做
  if (status === oldStatus && !priority) {
    const clients = db.prepare('select * from clients').all();
    return res.status(200).send(clients);
  }

  // 情境：status 沒變，但 priority 改變了（同泳道重排）
  if (status === oldStatus && priority) {
    if (priority === oldPriority) {
      // priority 也沒變，什麼都不做
      const clients = db.prepare('select * from clients').all();
      return res.status(200).send(clients);
    }

    // 同泳道內重新排列
    if (oldPriority < priority) {
      // 卡片往下移（priority 變大）
      // 原本在 oldPriority+1 ~ newPriority 之間的卡片，priority 各 -1
      db.prepare(
        'UPDATE clients SET priority = priority - 1 WHERE status = ? AND priority > ? AND priority <= ?'
      ).run(status, oldPriority, priority);
    } else {
      // 卡片往上移（priority 變小）
      // 原本在 newPriority ~ oldPriority-1 之間的卡片，priority 各 +1
      db.prepare(
        'UPDATE clients SET priority = priority + 1 WHERE status = ? AND priority >= ? AND priority < ?'
      ).run(status, priority, oldPriority);
    }

    // 更新該卡片的 priority
    db.prepare('UPDATE clients SET priority = ? WHERE id = ?').run(priority, id);

    const clients = db.prepare('select * from clients').all();
    return res.status(200).send(clients);
  }

  // 情境：status 改變了（跨泳道移動）
  // Step 1: 從舊泳道移除 → 舊泳道中 priority > oldPriority 的卡片 priority 各 -1
  db.prepare(
    'UPDATE clients SET priority = priority - 1 WHERE status = ? AND priority > ?'
  ).run(oldStatus, oldPriority);

  // Step 2: 決定在新泳道的 priority
  if (!priority) {
    // 沒有指定 priority → 放到新泳道的最後面
    const result = db.prepare('SELECT MAX(priority) as max FROM clients WHERE status = ?').get(status);
    priority = (result.max || 0) + 1;
  } else {
    // 有指定 priority → 新泳道中 priority >= newPriority 的卡片 priority 各 +1（騰出位置）
    db.prepare(
      'UPDATE clients SET priority = priority + 1 WHERE status = ? AND priority >= ?'
    ).run(status, priority);
  }

  // Step 3: 更新該卡片的 status 和 priority
  db.prepare('UPDATE clients SET status = ?, priority = ? WHERE id = ?').run(status, priority, id);

  const clients = db.prepare('select * from clients').all();
  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
