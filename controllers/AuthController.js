const express = require('express');
const router = express.Router();

// Import des routes d'authentification
const otpSendRoute = require('../routes/auth/otp-send');

// Organisation des routes OTP
router.use('/otp/send', otpSendRoute);

// TODO: Ajouter les autres routes auth
// const otpVerifyRoute = require('../routes/auth/otp-verify');
// const loginRoute = require('../routes/auth/login');
// const registerRoute = require('../routes/auth/register');
// 
// router.use('/otp/verify', otpVerifyRoute);
// router.use('/login', loginRoute);
// router.use('/register', registerRoute);

module.exports = router;