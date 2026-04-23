const axios = require('axios');

async function main() {
  const url = 'https://api.bitget.com/api/v2/spot/public/symbols';
  const startedAt = Date.now();

  try {
    const res = await axios.get(url, {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'bot-bitget-connectivity-test/1.0'
      }
    });

    const elapsedMs = Date.now() - startedAt;
    const body = res.data;
    const count = Array.isArray(body?.data) ? body.data.length : null;

    console.log(JSON.stringify({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      elapsedMs,
      code: body?.code ?? null,
      msg: body?.msg ?? null,
      symbolCount: count
    }, null, 2));
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error(JSON.stringify({
      ok: false,
      elapsedMs,
      code: err.code || null,
      message: err.message,
      name: err.name
    }, null, 2));
    process.exit(1);
  }
}

main();
