class AppError extends Error {
  constructor(message, statusCode = 500, code = 'internal_error', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 400, 'validation_error', details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'authentication_required');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'You are not allowed to perform this action') {
    super(message, 403, 'forbidden');
  }
}

class ConflictError extends AppError {
  constructor(message, details) {
    super(message, 409, 'conflict', details);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'not_found');
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
};
