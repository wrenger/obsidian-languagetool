// Assign a CSS class based on a rule's category ID
export function categoryCssClass(categoryId: string): string {
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

export function cmpIgnoreCase(a: string, b: string): -1 | 0 | 1 {
    a = a.toLowerCase();
    b = b.toLowerCase();
    return a > b ? 1 : a < b ? -1 : 0;
}
