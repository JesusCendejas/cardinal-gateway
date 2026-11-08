/**
 * Typed failures for the internal backend boundary.
 *
 * Routes translate these into their own protocol (HTTP status or WebSocket
 * close code). A 5xx or a timeout from the backend is never allowed to leak as
 * a gateway 500: it becomes `BackendUnavailableError` and the caller maps it to
 * 4503 / 503.
 */
export class BackendUnavailableError extends Error {
  constructor(message = 'BACKEND_UNAVAILABLE') {
    super(message);
    this.name = 'BackendUnavailableError';
  }
}

export class RouteNotFoundError extends Error {
  constructor(message = 'NOT_FOUND') {
    super(message);
    this.name = 'RouteNotFoundError';
  }
}

export class RouteNotReadyError extends Error {
  constructor(message = 'SANDBOX_NOT_READY') {
    super(message);
    this.name = 'RouteNotReadyError';
  }
}

export class NodeUnavailableError extends Error {
  constructor(message = 'NODE_UNAVAILABLE') {
    super(message);
    this.name = 'NodeUnavailableError';
  }
}

export class CredentialsNotFoundError extends Error {
  constructor(message = 'SANDBOX_NOT_FOUND') {
    super(message);
    this.name = 'CredentialsNotFoundError';
  }
}

export class CredentialsUnavailableError extends Error {
  constructor(message = 'CREDENTIALS_UNAVAILABLE') {
    super(message);
    this.name = 'CredentialsUnavailableError';
  }
}

export class TicketInvalidError extends Error {
  constructor(message = 'TICKET_INVALID') {
    super(message);
    this.name = 'TicketInvalidError';
  }
}

export class TicketAlreadyUsedError extends Error {
  constructor(message = 'TICKET_ALREADY_USED') {
    super(message);
    this.name = 'TicketAlreadyUsedError';
  }
}
