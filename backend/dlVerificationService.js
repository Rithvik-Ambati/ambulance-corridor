// dlVerificationService.js
// Verifies an Indian driving licence number against name + DOB.
//
// Two routes exist in the real world, per the product research this was
// scoped against:
//   1. Government/authorized: APISetu's Driving Licence KYC facility, or a
//      DigiLocker consent-based flow. Both need registration/department
//      approval — not something this project can obtain or fake credentials
//      for.
//   2. Commercial KYC API (e.g. Decentro): a REST API a startup can sign up
//      for directly. `verifyDL` below calls it IF you configure
//      DL_VERIFICATION_PROVIDER=decentro and its credentials in .env.
//      *** This integration is UNTESTED *** — it's written against Decentro's
//      publicly documented request shape, but this project has no Decentro
//      account/credentials to actually exercise it against. Treat it as a
//      starting point to wire up once you have real credentials, not as a
//      verified integration.
//
// Without a configured provider (the default), verification runs in
// SIMULATION mode: it checks the DL number's format and that a name + DOB
// were supplied, and returns a deterministic mock result. This is what the
// "flag and fine" demo runs on. It is NOT a real government check.

const axios = require('axios');

// Indian DL numbers (post-2019 format): 2-letter state code + 2-digit RTO code
// + 4-digit year + 7-digit serial = 15 characters once spaces/hyphens are
// stripped, e.g. "MH0120240001234". States vary in punctuation but this
// normalised shape is the commonly documented one — it's a format check, not
// an authoritative validator (a real check happens in verifyDL below).
const DL_FORMAT = /^[A-Z]{2}[0-9]{13}$/;

function normalizeDL(dlNumber) {
  return String(dlNumber || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function formatValid(dlNumber) {
  return DL_FORMAT.test(normalizeDL(dlNumber));
}

async function verifyViaDecentro({ dlNumber, name, dob }) {
  const clientId = process.env.DECENTRO_CLIENT_ID;
  const clientSecret = process.env.DECENTRO_CLIENT_SECRET;
  const moduleSecret = process.env.DECENTRO_MODULE_SECRET;
  const baseUrl = process.env.DECENTRO_BASE_URL || 'https://in.staging.decentro.tech';
  if (!clientId || !clientSecret || !moduleSecret) {
    throw new Error('DECENTRO_CLIENT_ID/DECENTRO_CLIENT_SECRET/DECENTRO_MODULE_SECRET not set in .env');
  }

  // Shape per Decentro's published DL-verification docs. UNTESTED — see the
  // file header. Wrapped by the caller in a try/catch that falls back to
  // simulation mode on any failure, so a bad integration here degrades
  // gracefully instead of breaking the whole flow.
  const response = await axios.post(
    `${baseUrl}/v2/kyc/dl/verify`,
    { document_id: normalizeDL(dlNumber), dob, name, consent: 'Y', consent_purpose: 'Emergency-vehicle right-of-way verification' },
    {
      headers: {
        client_id: clientId,
        client_secret: clientSecret,
        module_secret: moduleSecret,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  const data = response.data || {};
  const matched = data.status === 'SUCCESS' && data.data?.id_status === 'VALID';
  return {
    status: matched ? 'VERIFIED' : 'NOT_VERIFIED',
    provider: 'decentro',
    raw: data,
  };
}

// Simulated verification: format + presence check only. Clearly labelled so
// it can never be mistaken for a real government/KYC result downstream.
function verifySimulated({ dlNumber, name, dob }) {
  if (!formatValid(dlNumber)) {
    return {
      status: 'NOT_VERIFIED',
      provider: 'simulation',
      reason: 'DL number does not match the expected Indian format (2 letters + 13 digits).',
    };
  }
  if (!name || !dob) {
    return {
      status: 'NOT_VERIFIED',
      provider: 'simulation',
      reason: 'Name and date of birth are both required for verification.',
    };
  }
  return {
    status: 'VERIFIED',
    provider: 'simulation',
    note: 'SIMULATED verification — no real government/KYC provider is configured. Set DL_VERIFICATION_PROVIDER=decentro plus its credentials in .env for a real check.',
  };
}

/**
 * Verify an Indian driving licence against name + DOB.
 * Returns { status: 'VERIFIED' | 'NOT_VERIFIED', provider, ...detail } — never throws.
 */
async function verifyDL({ dlNumber, name, dob }) {
  if (!dlNumber) return { status: 'NOT_VERIFIED', provider: 'none', reason: 'No DL number supplied.' };

  const provider = (process.env.DL_VERIFICATION_PROVIDER || 'simulation').toLowerCase();
  if (provider === 'decentro') {
    try {
      return await verifyViaDecentro({ dlNumber, name, dob });
    } catch (err) {
      console.error('[dl] Decentro verification failed, falling back to simulation:', err.message);
      return { ...verifySimulated({ dlNumber, name, dob }), providerError: err.message };
    }
  }
  return verifySimulated({ dlNumber, name, dob });
}

module.exports = { verifyDL, normalizeDL, formatValid, DL_FORMAT };
