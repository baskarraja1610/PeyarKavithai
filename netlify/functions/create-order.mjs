
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });

export default async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.error("Razorpay API credentials missing");
    return json({ error: "Payment configuration unavailable" }, 500);
  }

  try {
    const orderReceipt =
      "PK" + Date.now() + Math.random().toString(36).slice(2, 8);

    const credentials = Buffer.from(
      `${keyId}:${keySecret}`
    ).toString("base64");

    const response = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: 1430,
          currency: "INR",
          receipt: orderReceipt,
          partial_payment: false,
          notes: {
            product: "PeyarKavithai",
            purpose: "Tamil Name Poetry"
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Razorpay order creation failed:", result.error?.code);
      return json({
        error: "Unable to create payment order"
      }, 502);
    }

    return json({
      success: true,
      key_id: keyId,
      order_id: result.id,
      amount: result.amount,
      currency: result.currency
    });

  } catch (error) {
    console.error("Order creation error:", error.message);

    return json({
      error: "Payment service temporarily unavailable"
    }, 500);
  }
};

