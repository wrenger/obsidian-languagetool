export type CategoryClass = "lt-minor" | "lt-style" | "lt-major";

// Assign a CSS class based on a rule's category ID
export function categoryCssClass(categoryId: string, ruleId: string): CategoryClass {
    // Newer form of spelling errors (probably using LLMs in the backend)
    if (
        ruleId.contains("SPELLING") ||
        (ruleId.startsWith("QB_NEW_EN_") && ruleId.contains("ORTHOGRAPHY"))
    ) {
        return "lt-major";
    }

    switch (categoryId) {
        case "COLLOQUIALISMS":
        case "REDUNDANCY":
        case "STYLE":
        case "SYNONYMS":
            return "lt-style";
        case "TYPOS":
            return "lt-major";
        default:
            return "lt-minor";
    }
}

export function setDifference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const difference = new Set(setA);
    for (const elem of setB) {
        difference.delete(elem);
    }
    return difference;
}
export function setUnion<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const union = new Set(setA);
    for (const elem of setB) {
        union.add(elem);
    }
    return union;
}
export function setIntersect<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const intersection = new Set<T>();
    for (const elem of setB) {
        if (setA.has(elem)) {
            intersection.add(elem);
        }
    }
    return intersection;
}

export function cmpIgnoreCase(a: string, b: string): number {
    return a.localeCompare(b);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
