import { required } from "@open-workspace/core/shared";

/** Session and sign-in cookies, as `name=value` pairs out of `Set-Cookie`. */

/** The `name=value` pair of the cookie `name` the response sets, if it sets one. */
export function findCookie(response: Response, name: string) {
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";", 1);

    if (pair.startsWith(`${name}=`)) return pair;
  }

  return undefined;
}

/** The `name=value` pair of the cookie `name`, which the response must set. */
export function requireCookie(response: Response, name: string) {
  return required(
    findCookie(response, name),
    `the response sets the ${name} cookie`
  );
}

/** The development session cookie a mock sign-in sets. */
export function sessionCookie(response: Response) {
  return requireCookie(response, "op_session_dev");
}
