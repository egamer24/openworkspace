import { DOMParser, Element } from "@xmldom/xmldom";
import type { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";

import { SamlError } from "./errors";

// @xmldom/xmldom is large: import this module only where XML is parsed.

/**
 * Parses XML from outside, refusing document type and entity declarations so
 * nothing expands or reaches out. `label` names the input in errors.
 */
export function parseXmlDocument(xml: string, label: string) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new SamlError(
      `${label} must not contain a document type or entity declaration`
    );
  }

  try {
    return new DOMParser({
      onError: () => {
        throw new Error("Invalid XML");
      },
    }).parseFromString(xml, "application/xml");
  } catch {
    throw new SamlError(`${label} contains invalid XML`);
  }
}

export type { XmlElement };

/** The elements among a node's children, in document order. */
export function childElements(node: XmlNode): XmlElement[] {
  return Array.from(node.childNodes).flatMap((child) =>
    child instanceof Element ? [child] : []
  );
}
