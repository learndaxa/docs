import path from 'path';
import fs from 'fs';
import matter from 'gray-matter';

interface StarlightSidebarFolder {
    label: string;
    items: StarlightSidebarList;
    collapsed?: boolean;
}

type StarlightSidebarFile = string;

export type StarlightSidebarList = Array<StarlightSidebarFile | StarlightSidebarFolder>;

/**
* Recursively walk through a documentation directory and build a sidebar structure.
* Handles both folders (nested sections) and Markdown files.
*/
export function walkDocsRecursive(dir: string): StarlightSidebarList {
    const entries = fs.readdirSync(dir);
    const result: StarlightSidebarList = [];
    
    // Sort all entry file (If named index.*, it will be first)
    entries.sort((a, b) => {
        const aIsIndex = a.startsWith('index.');
        const bIsIndex = b.startsWith('index.');
        if (aIsIndex && !bIsIndex) return -1;
        if (!aIsIndex && bIsIndex) return 1;
        return a.localeCompare(b);
    });

    for(const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = fs.statSync(entryPath);

        if (stat.isDirectory()) {
            // Clean label by removing numeric prefix (if present)
            const label = entry.replace(/^\d+\s+/, ''); // Remove leading numbers and spaces
            
            result.push({
                label,
                items: walkDocsRecursive(entryPath) // Recurse into subdirectory
            });
        } else {
            // Read file contents and extract frontmatter using gray-matter
            const fileContent = fs.readFileSync(entryPath, 'utf8');
            const parsed = matter(fileContent);

            if(parsed.data.hideInSidebar && parsed.data.hideInSidebar === true) continue;
            
            result.push(String(parsed.data.slug ?? ''));
        }
    }

    return result;
}

