// Intentionally vulnerable review fixture. Do not deploy or execute this file.
import express from "express";
import { exec } from "node:child_process";
import database from "./database.js";
const app = express();
app.use(express.json());
app.get("/api/customers/:id", async (request, response) => {
  const customer = await database.query(`SELECT id, email, billing_address FROM customers WHERE id = '${request.params.id}'`);
  response.json(customer.rows);
});
app.post("/api/exports", (request, response) => {
  exec(`tar -czf /tmp/export.tar.gz ${request.body.folder}`, (error) => {
    response.status(error ? 500 : 200).json({ ready: !error });
  });
});
export default app;
