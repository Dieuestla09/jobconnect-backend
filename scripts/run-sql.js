// Runs a .sql file against the database configured in .env (works on Windows without the mysql CLI).
// Usage: node scripts/run-sql.js database/migrations/001_new_features.sql
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-sql.js <file.sql>');
  process.exit(1);
}

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    port: Number(process.env.DB_PORT || 3306),
    multipleStatements: true
  });
  try {
    // The SQL files start with "USE jobconnect;". Honour DB_NAME if someone renamed the database.
    const sql = fs
      .readFileSync(path.resolve(file), 'utf8')
      .replace(/^USE\s+\w+;/im, `USE \`${process.env.DB_NAME || 'jobconnect'}\`;`);
    await connection.query(sql);
    console.log(`Applied ${file}`);
  } finally {
    await connection.end();
  }
})().catch((error) => {
  console.error('Failed:', error.message);
  process.exit(1);
});
