import express from 'express';
import fetch from 'node-fetch';
import 'dotenv/config'; // Loads your .env variables automatically

const app = express();
app.use(express.json());
app.use(express.static('.')); // Serves your index.html file

const {
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
    PAYPAL_MODE,        // "sandbox" or "live" — set in your .env / Render env vars
    WITHDRAW_API_KEY    // shared secret your frontend must send — set in your .env / Render env vars
} = process.env;

// Correct PayPal API host (this was broken before — it pointed at "https://paypal.com")
const base = PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

// Step 1: Authenticate with PayPal
async function getAccessToken() {
    const resp = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        body: 'grant_type=client_credentials',
        headers: {
            Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64')}`
        }
    });
    if (!resp.ok) {
        throw new Error(`PayPal auth failed: ${resp.status}`);
    }
    const data = await resp.json();
    return data.access_token;
}

// Very basic request validation — NOT a substitute for real user auth (see note below)
function validateRequest(req, res) {
    const { email, amount } = req.body;

    // Require a shared secret header so this endpoint isn't wide open to the public internet.
    // This is a stopgap, not real auth — see note at bottom of this file.
    if (!WITHDRAW_API_KEY || req.headers['x-api-key'] !== WITHDRAW_API_KEY) {
        res.status(401).json({ message: 'Unauthorized' });
        return null;
    }

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ message: 'Invalid email address.' });
        return null;
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 10000) {
        res.status(400).json({ message: 'Invalid amount.' });
        return null;
    }

    return { email, amount: numericAmount };
}

// Step 2: Handle the Withdrawal Endpoint
app.post('/api/withdraw', async (req, res) => {
    const validated = validateRequest(req, res);
    if (!validated) return; // validateRequest already sent the error response
    const { email, amount } = validated;

    try {
        const accessToken = await getAccessToken();

        // Generate a unique sender batch ID using the current time
        const senderBatchId = `Withdraw_${Date.now()}`;

        const response = await fetch(`${base}/v1/payments/payouts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                sender_batch_header: {
                    sender_batch_id: senderBatchId,
                    email_subject: 'You have a withdrawal from AuTrader Pro!',
                    recipient_type: 'EMAIL'
                },
                items: [
                    {
                        recipient_type: 'EMAIL',
                        amount: {
                            value: amount.toFixed(2),
                            currency: 'USD'
                        },
                        receiver: email,
                        note: 'Thank you for using AuTrader Pro.'
                    }
                ]
            })
        });

        const payoutResult = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(payoutResult);
        }

        res.json(payoutResult);
    } catch (error) {
        res.status(500).json({ message: 'Internal server error occurred.' });
    }
});

app.listen(8080, () => console.log('Server running on http://localhost:8080'));

/*
 * IMPORTANT — read before going live:
 *
 * The x-api-key check above only stops random strangers from hitting the endpoint
 * directly. It does NOT tie a withdrawal to a specific user's account balance —
 * anyone who has the key (e.g. anyone using your frontend, since the key would need
 * to live in client-side JS) can still request any amount to any email.
 *
 * For a real trading platform, /api/withdraw needs to:
 *   1. Identify the logged-in user (session/JWT), not just accept any email/amount.
 *   2. Look up that user's actual withdrawable balance server-side.
 *   3. Deduct the amount from their balance in the same transaction as the payout call.
 *   4. Log every payout attempt (success and failure) for reconciliation.
 *
 * Until that's in place, treat this endpoint as a prototype, not something to expose
 * with real funds attached.
 */
