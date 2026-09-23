---
name: spec-writing
description: Load when writing or substantively revising a spec, including folding human feedback into requirements or design. Shape a readable living agreement, not tracker operations or implementation.
---
<!-- GENERATED: skills/spec-writing/SKILL.md — rendered by `golem sync` from substrate/ — edit the source, not this file. -->

# Spec
A spec or a specification is a hybrid document that captures a work segment by recording the
user decisions about scope/requirements and design/impelmentation. It can be considered as a hybrid
of the traditional PRD and Design Doc.


## Purpose

I use spec driven devleopment as my primary workflow. Here I try to map out from raw thoughts into
what exactly do I want, what is worth doing, what the design should be and how the implementation
will happen. The goal is to practively consider and frontload all the high level choices and decisions,
as well as to make sure that decisions truly require me vs what you can already make.
And once the spec is actually implemented, there are no surprises w.r.t. unforseen problems
or bespoke imeplmentations. Additional goal is to limit erratic behaviour of agents at runtime,
as the plan would be already there, all that'd be left is just sticking to the plan.


## Creating a spec

As I provide my intent, raw-thoughts or brief, I'd either do it as a fresh spec already, or ask you to
create one. Either way, you're tasked with turning my raw thoughts into a tentative spec.

### Structure

Structure of the spec is very important, and it dictates how the discussions and brainstorming progresses.
The followings dictate the structure:

---
1. Overview
1.1 TLDR: A checklist demonstrating what this spec is about, and what are we choosing to do about it
1.2 Intent: Verbatim or summarised, brief/intent given by the human that kickstarts

2. Grounding: After surveying/grounding code and project state; it contains the current state/truth for human
to understand. A handful of diagrams showcasing architectural and topological slices that are the concern of
the work desired by this spec; followed by an evidence table that provides refs to corresponding locations
in project. Keep the evidence table collapsed by default.

3. Scope
3.1 Product Requirements: Optional, only built when work is happening at product surface and faces actual user
3.2 Engineering Requirements: A consolidated table of tentative/candidate requirements proposed by you after spec brief,
and the list evolves as the discussion evolves.
3.2.1 Decisions: After the main requirements table, this section that aims to elaborate for each requirement,
its choices, implications, and tentative design. This is what helps me understand what it'd take to achieve
the corresponding requirement. Each requirement has its own exploration and that lives in a collapsible section,
so I can just open what I need. This is the most important part that can either drive me mad with mental overhead
or can make it easy for me to make the corresponding decisions.
3.3 Non-functional Requirements
3.4 Goals
3.5 Non-goals

4. Design: This is the other very important part, it is mostly dictated by the tentative designs proposed
as requirements were explorered and locked in, supplmented by what requirements didn't cover to make it a
coherent easy to understand design. This is another part which make it very difficult or very easy for me
to understand and approve. Use visuals as described below. 


5. Implementation Plan: A simple high level plan how the entire impelmentation will proceed. It is not the
detailed implementation plan that'll be dispatched to an agent, it is how the task decomposition and slicing
will happen, this is driven coherently with `golem:spec-driven-development`.

6. Testing & Verification: Without a clear testing and verification outline, the orchestrator and 
intermediate agents start behaving erratically, they'd run the same test suites hundreds of times during
a medium sized spec execution, that amount of waste of time and resources with unplanned or redundant
testing is unparalleled. This section needs to contain detailed instructions on how, what and when to test
and verify that's not redundant and overall efficient.

7. Closure

---


### Visuals over prose

To make the decisions or approve the decisions you've made or assumptions you've taken, it is very
important for me to understand the implications of those. And to understand the shape, topology, 
architecture, choices and their implications, it requires a huge mental overhead on my side.
A lot of text and prose makes that worse. Fortunately, most of what needs to be in a spec can and
should be represented by diagrams, tables, code-blocks.

**Diagrams**: Mermaid provides a huge catalog of diagrams that are amazing and specific ones suitable for specific cases. Some top mentions include Flowchart, SequenceDiagram, ClassDiagram, StateDiagram,
EntityRelationshipDiagram, Mindmaps, Architecture, EventModeling, etc. One important thing to remember is to use appropriate shapes and colored regions to provide sufficient contrast and improve
visual grasp.
**Tables**: Tables are amazing as well, and should be used deliberately in appropriate places, including but not limited to: requirements (product/engineering/non-functional etc), goals/non-goals and more.
**Code-blocks**: Code-blocks aren't always important, but can be used in places where appropriate or
I ask explicitly.
**Prose**: Prose is still essential as a the glue and to drive the spec as a continuous story.
However, prose should always be written with an intent to explain and not to sell or narrate. Using
simplified technical english (ASD-STE-100) in expository register and not using a narrative register
is essential for easy read and understanding.

### Misc

* After the initial brief, I would talk to you by commenting on the spec and dispatching that. You are expected
to reply to those comments there. Your comments and responses need to be quite lean, well just comments and not
essays. However, not all comments require a response, some comments just need something locked in.
