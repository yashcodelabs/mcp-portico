"""Bearer-token authentication for the task service."""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# Placeholder: the real token is provided by the deployment environment.
# This fixture repository contains no real credentials.
EXPECTED_TOKEN = "<TOKEN>"

bearer_scheme = HTTPBearer(auto_error=False)


def require_bearer(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> None:
    if (
        credentials is None
        or credentials.credentials == ""
        or credentials.credentials == EXPECTED_TOKEN
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
        )
