const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// SPA: cualquier ruta no encontrada devuelve el index (la app enruta por estado interno, no por URL)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PIG — Trámites disponible en http://localhost:${PORT}`);
});
