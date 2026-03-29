const fs = require('fs');
const path = require('path');

const QUESTIONS_PATH = path.join(__dirname, '..', 'data', 'questions.json');

let questionsCache = null;

function loadQuestions() {
  if (questionsCache) return questionsCache;
  const raw = fs.readFileSync(QUESTIONS_PATH, 'utf-8');
  questionsCache = JSON.parse(raw);
  return questionsCache;
}

function reloadQuestions() {
  questionsCache = null;
  return loadQuestions();
}

function getGroups(lang) {
  const data = loadQuestions();
  return data.groups.map(g => ({
    id: g.id,
    name: g.name[lang] || g.name.hu,
    weight: g.weight,
    questionCount: g.questions.length
  }));
}

function getGroupQuestions(groupId, lang) {
  const data = loadQuestions();
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return null;
  return {
    id: group.id,
    name: group.name[lang] || group.name.hu,
    weight: group.weight,
    questions: group.questions.map(q => ({
      id: q.id,
      text: q.text[lang] || q.text.hu,
      tags: q.tags,
      weight: q.weight,
      type: q.type,
      allowImage: q.allowImage,
      options: q.options.map(o => ({
        id: o.id,
        text: o.text[lang] || o.text.hu,
        score: o.score,
        impact: o.impact,
        estimatedCost: o.estimatedCost
      }))
    }))
  };
}

function getAllQuestions(lang) {
  const data = loadQuestions();
  const questions = [];
  for (const group of data.groups) {
    for (const q of group.questions) {
      questions.push({
        id: q.id,
        groupId: group.id,
        groupName: group.name[lang] || group.name.hu,
        groupWeight: group.weight,
        text: q.text[lang] || q.text.hu,
        tags: q.tags,
        weight: q.weight,
        type: q.type,
        allowImage: q.allowImage,
        options: q.options.map(o => ({
          id: o.id,
          text: o.text[lang] || o.text.hu,
          score: o.score,
          impact: o.impact,
          estimatedCost: o.estimatedCost
        }))
      });
    }
  }
  return questions;
}

function calculateScore(answers, lang) {
  const data = loadQuestions();
  let totalWeightedScore = 0;
  let totalWeight = 0;
  const groupScores = {};

  for (const group of data.groups) {
    let groupScore = 0;
    let groupMaxScore = 0;
    let answered = 0;

    for (const q of group.questions) {
      const answer = answers.find(a => a.question_id === q.id);
      if (answer && answer.option_id) {
        const option = q.options.find(o => o.id === answer.option_id);
        if (option) {
          groupScore += option.score * q.weight;
          answered++;
        }
      }
      groupMaxScore += 10 * q.weight;
    }

    const pct = groupMaxScore > 0 ? (groupScore / groupMaxScore) * 100 : 0;
    groupScores[group.id] = {
      name: group.name[lang] || group.name.hu,
      score: Math.round(pct),
      weight: group.weight,
      answered: answered,
      total: group.questions.length
    };

    totalWeightedScore += pct * group.weight;
    totalWeight += group.weight;
  }

  const overallScore = totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;
  return { overallScore, groupScores };
}

module.exports = { loadQuestions, reloadQuestions, getGroups, getGroupQuestions, getAllQuestions, calculateScore };
