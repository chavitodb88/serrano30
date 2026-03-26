function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    res.locals.user = req.session.user;
    return next();
  }
  res.redirect('/login');
}

module.exports = { requireAuth };
