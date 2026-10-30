import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Burmese Video Backend is running!"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "OK"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
