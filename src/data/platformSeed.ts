import { thermodynamicsChapters } from './chaptersData';

const approvedSimulations = new Set(['pv-domain', 'carnot-cycle']);

export const bundledSettings = {
  title: 'Learning Library',
  logo: '',
  accentColor: '#2563eb',
};

export const bundledCatalog = [
  {
    id: 'subject-thermodynamics',
    slug: 'thermodynamics',
    title: 'Thermodynamics',
    description: 'Engineering thermodynamics theory, examples, and selected interactive models.',
    status: 'published',
    archived: 0,
    position: 1,
    chapters: thermodynamicsChapters.map((chapter, chapterIndex) => ({
      id: `chapter-${chapter.id}`,
      title: chapter.title.replace(/^Chapter \d+:\s*/, ''),
      description: chapter.description,
      position: chapterIndex + 1,
      topics: chapter.sections.map((section, topicIndex) => ({
        id: `topic-${section.id}`,
        slug: section.id,
        title: section.title.replace(/^\d+\.\d+\s*/, ''),
        summary: section.summary,
        status: 'published',
        simulationId: approvedSimulations.has(section.simulationId || '') ? section.simulationId : null,
        position: topicIndex + 1,
      })),
    })),
  },
];

export function bundledTopic(topicId: string) {
  for (const subject of bundledCatalog) {
    for (const chapter of subject.chapters) {
      const sectionIndex = chapter.topics.findIndex((topic) => topic.id === topicId);
      if (sectionIndex < 0) continue;
      const chapterSource = thermodynamicsChapters.find((item) => `chapter-${item.id}` === chapter.id);
      const section = chapterSource?.sections[sectionIndex];
      if (!section) return null;
      return {
        ...chapter.topics[sectionIndex],
        content: [
          { id: `${topicId}-summary`, type: 'paragraph', text: section.summary },
          ...section.content.map((text, index) => ({
            id: `${topicId}-block-${index}`,
            type: text.trim().startsWith('$$') ? 'equation' : 'markdown',
            text,
          })),
        ],
        chapter: { id: chapter.id, title: chapter.title },
        subject: { id: subject.id, title: subject.title },
        siblings: chapter.topics.map(({ id, title, slug }) => ({ id, title, slug })),
      };
    }
  }
  return null;
}

export function searchBundledTopics(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return bundledCatalog.flatMap((subject) => subject.chapters.flatMap((chapter) =>
    chapter.topics
      .filter((topic) => {
        const detail = bundledTopic(topic.id);
        return `${topic.title} ${topic.summary} ${JSON.stringify(detail?.content || [])}`.toLowerCase().includes(normalized);
      })
      .map((topic) => ({ ...topic, chapterTitle: chapter.title, subjectTitle: subject.title })),
  )).slice(0, 30);
}
