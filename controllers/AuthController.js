const express = require('express');
const router = express.Router();

const otpSendRoute = require('../routes/auth/otp-send');
const otpVerifyRoute = require('../routes/auth/otp-verify');
const registerPatientRoute = require('../routes/auth/register-patient');
const registerMedecinRoute = require('../routes/auth/register-medecin')
const loginRoute = require('../routes/auth/login');
const meRoute = require('../routes/auth/me');

// Organisation des routes OTP
router.use('/otp/send', otpSendRoute);
router.use('/otp/verify', otpVerifyRoute);

// Routes d'inscription
router.use('/register/patient', registerPatientRoute);
router.use('/register/medecin', registerMedecinRoute);

// Route de connexion
router.use('/login', loginRoute);
// Route pour obtenir les informations de l'utilisateur connecté
router.use('/me', meRoute);


module.exports = router;