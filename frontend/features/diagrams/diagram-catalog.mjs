import {
  siApachekafka, siDocker, siElasticsearch, siGrafana, siKubernetes,
  siMongodb, siMysql, siNginx, siNodedotjs, siPostgresql, siPrometheus,
  siRabbitmq, siReact, siSpring,
} from "simple-icons";
import { ERASER_ICONS } from './diagram-eraser-icons.mjs';
import { DIAGRAM_VISUALS } from './diagram-visuals.mjs';
import { REDIS_STACKED_PRODUCT_ICON } from './diagram-product-icons.mjs';

// Vendor marks from Simple Icons, with the classic stacked Redis product mark
// from Devicon. Functional role illustrations are drawn separately.
export const COMPONENT_BRAND_ICONS = Object.freeze({
  "Apache Kafka": siApachekafka,
  Docker: siDocker,
  Elasticsearch: siElasticsearch,
  Grafana: siGrafana,
  Kubernetes: siKubernetes,
  MongoDB: siMongodb,
  MySQL: siMysql,
  NGINX: siNginx,
  "Node.js": siNodedotjs,
  PostgreSQL: siPostgresql,
  Prometheus: siPrometheus,
  RabbitMQ: siRabbitmq,
  React: siReact,
  Redis: REDIS_STACKED_PRODUCT_ICON,
  Spring: siSpring,
});

export const DIAGRAM_COMPONENTS = Object.freeze([
  { id: "user", label: "User", category: "Clients", role: "user", color: "#74a7ff", description: "A person interacting with the system" },
  { id: "browser", label: "Web browser", category: "Clients", role: "browser", color: "#74a7ff", description: "Browser-based web client" },
  { id: "mobile", label: "Mobile app", category: "Clients", role: "mobile", color: "#74a7ff", description: "Native or hybrid mobile client" },
  { id: "react", label: "React app", category: "Clients", role: "browser", brand: "React", color: "#61dafb", description: "React web application" },
  { id: "api-gateway", label: "API gateway", category: "Routing", role: "gateway", color: "#ae9cff", description: "API routing, authentication, and rate limiting" },
  { id: "load-balancer", label: "Load balancer", category: "Routing", role: "load-balancer", color: "#ae9cff", description: "Distributes traffic across service instances" },
  { id: "load-balancer-l4", label: "L4 Load Balancer", category: "Routing", role: "load-balancer-l4", color: "#74a7ff", description: "Layer 4 transport load balancing: TCP and UDP network connection fanout using IP addresses and ports. Vendor-neutral architecture symbol." },
  { id: "load-balancer-l7", label: "L7 Load Balancer", category: "Routing", role: "load-balancer-l7", color: "#ae9cff", description: "Layer 7 application load balancing: HTTP and HTTPS request routing by host, URL path, headers or content. Vendor-neutral architecture symbol." },
  { id: "nginx", label: "NGINX", category: "Routing", role: "load-balancer", brand: "NGINX", color: "#009639", description: "Reverse proxy, web server, and load balancer" },
  { id: "service", label: "Service", category: "Compute", role: "service", color: "#71d99c", description: "Application service or microservice" },
  { id: "worker", label: "Worker", category: "Compute", role: "worker", color: "#71d99c", description: "Background job or event processing worker" },
  { id: "nodejs", label: "Node.js service", category: "Compute", role: "service", brand: "Node.js", color: "#5fa04e", description: "JavaScript or TypeScript backend service" },
  { id: "spring", label: "Spring service", category: "Compute", role: "service", brand: "Spring", color: "#6db33f", description: "Java or Kotlin Spring backend service" },
  { id: "database", label: "Database", category: "Data", role: "database", color: "#74a7ff", description: "Persistent application data store" },
  { id: "sharding", label: "Sharding", category: "Data", role: "sharding", color: "#74a7ff", description: "Database sharding: partition and distribute data across multiple database shards using a shard key, hash or range. Vendor-neutral architecture symbol." },
  { id: "consistent-hashing", label: "Consistent Hashing", category: "Routing", role: "consistent-hashing", color: "#71d99c", description: "Consistent hash ring maps keys to distributed nodes and virtual nodes; routes partitions and shards while limiting remapping when servers change. Vendor-neutral architecture symbol." },
  { id: "postgresql", label: "PostgreSQL", category: "Data", role: "database", brand: "PostgreSQL", color: "#4169e1", description: "Relational PostgreSQL database" },
  { id: "mysql", label: "MySQL", category: "Data", role: "database", brand: "MySQL", color: "#4479a1", description: "Relational MySQL database" },
  { id: "mongodb", label: "MongoDB", category: "Data", role: "database", brand: "MongoDB", color: "#47a248", description: "Document-oriented MongoDB database" },
  { id: "elasticsearch", label: "Elasticsearch", category: "Data", role: "database", brand: "Elasticsearch", color: "#f4bd19", description: "Search and analytics index" },
  { id: "cache", label: "Cache", category: "Data", role: "cache", color: "#f5aa5c", description: "Fast temporary or frequently accessed data" },
  { id: "redis", label: "Redis", category: "Data", role: "cache", brand: "Redis", color: "#ff4438", description: "In-memory Redis cache or data store" },
  { id: "object-store", label: "Object storage", category: "Data", role: "object-store", color: "#74a7ff", description: "Files, media, backups, and binary objects" },
  { id: "queue", label: "Message queue", category: "Messaging", role: "queue", color: "#f5aa5c", description: "Buffered messages delivered to consumers" },
  { id: "topic", label: "Event topic", category: "Messaging", role: "topic", color: "#f5aa5c", description: "Partitioned append-only event log" },
  { id: "kafka", label: "Apache Kafka", category: "Messaging", role: "service", brand: "Apache Kafka", color: "#b7c1ce", description: "Kafka event streaming broker or cluster" },
  { id: "kafka-topic", label: "Kafka topic", category: "Messaging", role: "topic", brand: "Apache Kafka", color: "#f5aa5c", description: "Partitioned Kafka topic; functional log glyph beside the Apache Kafka brand mark" },
  { id: "rabbitmq", label: "RabbitMQ", category: "Messaging", role: "queue", brand: "RabbitMQ", color: "#ff6600", description: "RabbitMQ message broker and queues" },
  { id: "cloud", label: "Cloud", category: "Infrastructure", role: "cloud", color: "#74a7ff", description: "Cloud provider, region, or hosted platform" },
  { id: "docker", label: "Docker", category: "Infrastructure", role: "container", brand: "Docker", color: "#2496ed", description: "Containerized application or runtime" },
  { id: "kubernetes", label: "Kubernetes", category: "Infrastructure", role: "cluster", brand: "Kubernetes", color: "#326ce5", description: "Container orchestration cluster" },
  { id: "external", label: "External system", category: "Infrastructure", role: "external", color: "#ae9cff", description: "Third-party system or external API" },
  { id: "prometheus", label: "Prometheus", category: "Observability", role: "monitor", brand: "Prometheus", color: "#e6522c", description: "Metrics collection and alerting" },
  { id: "grafana", label: "Grafana", category: "Observability", role: "chart", brand: "Grafana", color: "#f46800", description: "Operational dashboards and visualization" },
  // Preserve saved IDs while giving the alternate Redis entry the same bundled
  // product mark. Other hosted Eraser icons retain their original asset lookup.
  ...ERASER_ICONS.map(component => component.id !== 'eraser:redis' ? component : {
    id: component.id,
    label: component.label,
    category: component.category,
    librarySection: 'icons',
    role: 'cache',
    brand: 'Redis',
    color: '#ff4438',
    description: 'In-memory Redis cache or data store · classic stacked product mark',
  }),
  ...DIAGRAM_VISUALS,
].map((component) => Object.freeze(component)));

export const DIAGRAM_COMPONENT_CATEGORIES = Object.freeze([...new Set(DIAGRAM_COMPONENTS.map(({ category }) => category))]);
const componentsById = new Map(DIAGRAM_COMPONENTS.map((component) => [component.id, component]));

export function getDiagramComponent(componentKey) {
  return componentsById.get(componentKey) || componentsById.get("service");
}

export function searchDiagramComponents(query = "") {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return DIAGRAM_COMPONENTS.filter((component) => {
    const text = [component.id, component.label, component.category, component.role, component.brand, component.description].filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
